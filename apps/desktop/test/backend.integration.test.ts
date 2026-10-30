// @vitest-environment node
import {
  appUrl,
  asDestinationId,
  asPresetId,
  asSourceId,
  type CredentialSecret,
  type FolderDestination,
  type FtpDestination,
  type FtpSource,
  type IngestConfig,
  type IpcHandlers,
  type ExportJob,
  type ExportPreset,
  type Photo,
  type SourceConfig,
  type UploadItem,
} from '@ee/contracts';
import { assertNoEmbeddedPreviews } from '@ee/export';
import {
  ensureXmpFile,
  readEditParams,
  readIptc,
  readPhotoLabels,
  writeIptc,
  ExifToolService,
} from '@ee/metadata';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { copyInto, faceJpeg, fixtureNefs, hasFaceFixtures, sampleNefs } from './helpers/fixtures';
import { startFtpServer, type TestFtpServer } from './helpers/ftp-server';

const nefs = fixtureNefs();
const userNefs = sampleNefs();

interface Collected {
  channel: string;
  payload: unknown;
}

/** Everything pushed to the renderer, in order, with a way to sleep until the next push. */
const events: Collected[] = [];
const wakeWaiters: (() => void)[] = [];
const pushEvent = (event: Collected): void => {
  events.push(event);
  for (const wake of wakeWaiters.splice(0)) wake();
};

/**
 * Re-check `probe` whenever the backend emits an event (upload and ingest state
 * changes, new photos), so the wait is as short as the work and does not depend on
 * how loaded the machine is. A slow poll stays as a safety net, and the failure
 * message says what was being waited for and what the last events were.
 */
async function waitFor<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) {
      const recent = events
        .slice(-8)
        .map((e) => {
          const { type, state, destinationId, error } = e.payload as Record<string, unknown>;
          return [e.channel, type, state, destinationId, error].filter(Boolean).join(' ');
        })
        .join('\n');
      throw new Error(`timed out waiting for ${what}; last events:\n${recent}`);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      wakeWaiters.push(() => (clearTimeout(timer), resolve()));
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Export jobs ask the renderer (here the test) for each render. Answer every
 * request for the job and wait until the job reaches a terminal state.
 */
async function runExportJob(
  handlerSet: IpcHandlers,
  args: Parameters<IpcHandlers['export:start']>[0],
  render: (
    photoId: string,
    expectedOpsKey: string,
  ) => { width: number; height: number; rgba: Uint8Array },
  opsKeyFor?: (photoId: string, expectedOpsKey: string) => string,
): Promise<ExportJob> {
  const jobId = await handlerSet['export:start'](args);
  const handled = new Set<string>();
  for (;;) {
    const request = events.find((event) => {
      const payload = event.payload as { type?: string; jobId?: string; requestId?: string };
      return (
        event.channel === 'jobs:event' &&
        payload.type === 'export.render' &&
        payload.jobId === jobId &&
        payload.requestId !== undefined &&
        !handled.has(payload.requestId)
      );
    });
    if (request) {
      const payload = request.payload as {
        requestId: string;
        photoId: string;
        opsKey: string;
      };
      handled.add(payload.requestId);
      await handlerSet['export:render']({
        jobId,
        requestId: payload.requestId,
        rendered: render(payload.photoId, payload.opsKey),
        opsKey: opsKeyFor?.(payload.photoId, payload.opsKey) ?? payload.opsKey,
      });
      continue;
    }
    const state = events.find((event) => {
      const payload = event.payload as { type?: string; jobId?: string; state?: string };
      return (
        event.channel === 'jobs:event' &&
        payload.type === 'export.state' &&
        payload.jobId === jobId &&
        payload.state !== undefined &&
        ['done', 'failed', 'cancelled'].includes(payload.state)
      );
    });
    if (state) return (state.payload as { job: ExportJob }).job;
    await sleep(20);
  }
}

const testPreset = (overrides: Partial<ExportPreset> = {}): ExportPreset => ({
  id: asPresetId('test-preset'),
  name: 'Test',
  folderTemplate: 'Export/{preset}',
  fileNameTemplate: '{filenamebase}',
  ifExists: 'suffix',
  format: 'jpeg',
  quality: 88,
  colorSpace: 'srgb',
  resize: { mode: 'none' },
  outputSharpening: { target: 'none', amount: 'standard' },
  metadata: 'all',
  stripGps: false,
  version: 'top',
  sendTo: [],
  ...overrides,
});

const SECRETS: Record<string, CredentialSecret> = {
  'source-ftp': { password: 'src-secret' },
  'dest-ftp': { password: 'dest-secret' },
};

describe.skipIf(nefs.length === 0)(
  'backend (jobs services in plain Node)',
  { timeout: 120_000 },
  () => {
    let root: string;
    let backend: Backend;
    let handlers: IpcHandlers;
    let sourceServer: TestFtpServer;
    let destServer: TestFtpServer;
    const exiftool = new ExifToolService();

    const cardA = asSourceId('card-a');
    const cardB = asSourceId('card-b');
    const ftp = asSourceId('ftp-src');
    const added = (): Photo[] =>
      events.filter((e) => e.channel === 'photos:added').map((e) => e.payload as Photo);
    const bySource = (id: string): Photo[] => added().filter((p) => p.sourceId === id);

    let templatePath: string;
    let ingestConfig: IngestConfig;
    const ftpSource = (): FtpSource => ({
      id: ftp,
      name: 'ftp',
      kind: 'ftp',
      host: '127.0.0.1',
      port: sourceServer.port,
      username: 'cam',
      credentialRef: 'source-ftp',
      remotePath: '/',
      pollIntervalMs: 200,
      deleteAfterDownload: false,
      security: 'none',
    });
    const template = {
      caption: 'Match report',
      byline: 'Jane Doe',
      credit: 'Test Agency',
      city: 'Stockholm',
      keywords: ['football', 'derby'],
    };

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'ee-backend-'));
      const [a, b, remote, dest, ingestDest, userData] = [
        'a',
        'b',
        'remote',
        'dest',
        'ingest',
        'userdata',
      ].map((name) => join(root, name));
      for (const dir of [a, b, remote, dest, ingestDest, userData])
        await mkdir(dir!, { recursive: true });

      // Each source gets copies; the originals under fixtures/ and EE_SAMPLE_NEF_DIR are only read.
      const [first = nefs[0]!, second = nefs[0]!] = nefs;
      copyInto(first, join(a!, 'A1.NEF'));
      copyInto(second, join(a!, 'A2.NEF'));
      userNefs.forEach((nef, i) => copyInto(nef, join(a!, `A${i + 3}.NEF`)));
      copyInto(first, join(b!, 'B1.NEF'));
      if (hasFaceFixtures()) copyInto(faceJpeg, join(b!, 'B2.jpg'));
      copyInto(second, join(remote!, 'F1.NEF'));
      copyInto(first, join(remote!, 'F2.NEF'));

      templatePath = join(root, 'template.XMP');
      await ensureXmpFile(templatePath);
      await writeIptc(templatePath, template, { service: exiftool });

      sourceServer = await startFtpServer({
        root: remote!,
        username: 'cam',
        password: 'src-secret',
      });
      destServer = await startFtpServer({ root: dest!, username: 'desk', password: 'dest-secret' });

      backend = await createBackend({
        userDataDir: userData!,
        appVersion: 'test',
        homeDir: root,
        emit: (channel, payload) => pushEvent({ channel, payload }),
        getSecret: async (ref) => {
          const secret = SECRETS[ref];
          if (!secret) throw new Error(`no secret ${ref}`);
          return secret;
        },
        uploadQueue: { retryBaseDelayMs: 50, retryMaxDelayMs: 200 },
      });
      handlers = backend.handlers as IpcHandlers;

      ingestConfig = {
        sources: [
          { id: cardA, name: 'cardA', kind: 'folder', path: a! },
          { id: cardB, name: 'cardB', kind: 'folder', path: b! },
          ftpSource(),
        ],
        destination: { path: ingestDest!, subfolderTemplate: '{sourceName}' },
        renameTemplate: '{sourceName}_{seq:3}',
        metadataTemplatePath: templatePath,
        codeReplacementPaths: [],
      };
      const jobs = await handlers['ingest:start']({ config: ingestConfig });
      expect(jobs.map((job) => job.sourceId).sort()).toEqual([cardA, cardB, ftp].sort());

      const expected = 2 + userNefs.length + (hasFaceFixtures() ? 2 : 1) + 2;
      await waitFor('all photos to be ingested', () => added().length >= expected);
    }, 180_000);

    afterAll(async () => {
      await handlers?.['ingest:stop']();
      await backend?.dispose();
      await exiftool.close();
      await sourceServer?.close();
      await destServer?.close();
      if (root) await rm(root, { recursive: true, force: true });
    }, 60_000);

    it('ingests each source in filename order, renamed by the template', () => {
      const names = (id: string): string[] => bySource(id).map((p) => p.fileName);
      const aNames = names(cardA);
      expect(aNames.slice(0, 2)).toEqual(['cardA_001.NEF', 'cardA_002.NEF']);
      expect(aNames).toHaveLength(2 + userNefs.length);
      expect(names(cardB)[0]).toBe('cardB_001.NEF');
      if (hasFaceFixtures()) expect(names(cardB)).toEqual(['cardB_001.NEF', 'cardB_002.jpg']);
      expect(names(ftp)).toEqual(['ftp_001.NEF', 'ftp_002.NEF']);
      for (const photo of added())
        expect(photo.path).toContain(
          `/${photo.sourceId === ftp ? 'ftp' : photo.sourceId === cardA ? 'cardA' : 'cardB'}/`,
        );
    });

    it('indexes the photos and lists them in ingest order', async () => {
      const listed = await handlers['photos:list']();
      expect(listed.map((p) => p.id)).toEqual(added().map((p) => p.id));
      expect(await handlers['photos:list']({ sourceId: ftp })).toHaveLength(2);
      const first = bySource(cardA)[0]!;
      expect(await handlers['photos:get']({ photoId: first.id })).toEqual(first);
      expect(first.camera?.make).toBeTruthy();
      expect(first.width).toBeGreaterThan(first.height ?? 0);
      expect(first.status).toMatchObject({
        ingest: 'done',
        edited: false,
        metadataDiffersFromTemplate: false,
      });
    });

    it('caches a ~2560px preview and ~320px thumbnail, correctly oriented, served over app://', async () => {
      for (const photo of added()) {
        for (const [kind, limit] of [
          ['thumb', 320],
          ['preview', 2560],
        ] as const) {
          const response = await backend.resolveAppRequest(appUrl[kind](photo.id));
          expect(response.status).toBe(200);
          expect(response.headers['content-type']).toBe('image/jpeg');
          const meta = await sharp(await readFile(response.file!)).metadata();
          expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(limit);
          // Same aspect as the oriented full-resolution image, so rotation was applied.
          expect(meta.width! / meta.height!).toBeCloseTo(photo.width! / photo.height!, 1);
          expect(meta.exif).toBeUndefined();
        }
      }
      const missing = await backend.resolveAppRequest(appUrl.thumb('nope' as never));
      expect(missing.status).toBe(404);
    });

    it('writes the metadata template to a sidecar for raws and into the file for JPEGs', async () => {
      for (const photo of added()) {
        const fields = await handlers['metadata:read']({ photoId: photo.id });
        expect(fields).toMatchObject(template);
      }
      const raw = bySource(cardA)[0]!;
      expect(raw.sidecarPath).toBe(raw.path.replace(/\.NEF$/, '.xmp'));
      expect((await stat(raw.sidecarPath)).isFile()).toBe(true);
      expect(await readIptc(raw.sidecarPath, exiftool)).toMatchObject(template);
    });

    it('serves the linear image with its header, caching repeated decodes', async () => {
      const raw = bySource(cardA)[0]!;
      const first = await backend.resolveAppRequest(appUrl.linear(raw.id, 512));
      expect(first.status).toBe(200);
      const header = JSON.parse(first.headers['x-ee-linear-image']!);
      expect(header).toMatchObject({ sampleType: 'f16' });
      expect(Math.max(header.width, header.height)).toBeLessThanOrEqual(512);
      expect((await stat(first.file!)).size).toBe(header.width * header.height * 4 * 2);
      expect(Number(first.headers['content-length'])).toBe(header.width * header.height * 8);

      const again = await backend.resolveAppRequest(appUrl.linear(raw.id, 512));
      expect(again.file).toBe(first.file);

      expect((await backend.resolveAppRequest(appUrl.linear(raw.id, 3))).status).toBe(400);
      expect((await backend.resolveAppRequest(appUrl.linear('nope' as never))).status).toBe(404);
    });

    it('keeps metadataDiffersFromTemplate up to date and announces changes', async () => {
      const photo = bySource(cardB)[0]!;
      const before = events.length;
      const updated = await handlers['metadata:write']({
        photoId: photo.id,
        fields: { caption: 'Edited' },
      });
      expect(updated.status.metadataDiffersFromTemplate).toBe(true);
      expect(events.slice(before).some((e) => e.channel === 'photos:updated')).toBe(true);
      expect(await handlers['metadata:read']({ photoId: photo.id })).toMatchObject({
        caption: 'Edited',
      });

      const result = await handlers['metadata:applyTemplate']({
        photoIds: [photo.id],
        templatePath,
        mode: 'replace',
      });
      expect(result).toEqual({ updated: [photo.id], failed: [] });
      expect(
        (await handlers['photos:get']({ photoId: photo.id })).status.metadataDiffersFromTemplate,
      ).toBe(false);
      expect(await handlers['metadata:readTemplate']({ path: templatePath })).toEqual(template);
    });

    it('expands code replacements and variables in captions', async () => {
      const codes = join(root, 'codes.txt');
      await import('node:fs/promises').then((fs) => fs.writeFile(codes, 'gk\tgoalkeeper {city}\n'));
      const photo = bySource(cardB)[0]!;
      const result = await handlers['metadata:expandCaption']({
        photoId: photo.id,
        text: '=gk= saves in {city} (=nope=)',
        codeReplacementPaths: [codes],
      });
      expect(result.text).toContain('goalkeeper Stockholm saves in Stockholm');
      expect(result.unresolved).toEqual(['=nope=']);
    });

    it('stores develop params in the sidecar (crs:) and imports presets', async () => {
      const photo = bySource(cardA)[1]!;
      await handlers['develop:setParams']({
        photoId: photo.id,
        params: { Exposure2012: 0.5, Temperature: 5200, Tint: 4, Contrast2012: 10 },
      });
      expect(await handlers['develop:getParams']({ photoId: photo.id })).toMatchObject({
        Exposure2012: 0.5,
        Temperature: 5200,
      });
      expect(await readEditParams(photo.path, exiftool)).toMatchObject({ Exposure2012: 0.5 });
      const after = await handlers['photos:get']({ photoId: photo.id });
      expect(after.status.edited).toBe(true);
      expect(after.versions[0]).toMatchObject({ kind: 'develop', ops: { Exposure2012: 0.5 } });
      await expect(
        handlers['develop:getParams']({ photoId: photo.id, versionId: 'other' as never }),
      ).rejects.toMatchObject({ code: 'not_found' });

      const presetFile = join(root, 'Punchy.xmp');
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(
          presetFile,
          `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
            `<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ` +
            `crs:PresetType="Normal" crs:Exposure2012="+0.30" crs:Contrast2012="+20" crs:Clarity2012="+10"/>` +
            `</rdf:RDF></x:xmpmeta>`,
        ),
      );
      const preset = await handlers['develop:importPreset']({ path: presetFile });
      expect(preset.params).toMatchObject({ Exposure2012: 0.3, Contrast2012: 20 });
      expect((await handlers['develop:listPresets']()).map((p) => p.id)).toContain(preset.id);
    });

    it('applies copied setting groups to a batch and writes every sidecar', async () => {
      const targets = [bySource(cardA)[0]!, bySource(cardB)[0]!, bySource(ftp)[0]!];
      await handlers['develop:setParams']({
        photoId: targets[0]!.id,
        params: { Saturation: 30 },
      });
      const version = await handlers['photos:createVersion']({
        photoId: targets[0]!.id,
        kind: 'retouch',
        name: 'Retouch',
      });
      const op = {
        type: 'mosaic' as const,
        shapes: [{ type: 'rect' as const, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
        blockSizeRel: 0.012,
      };
      await handlers['retouch:set']({
        photoId: targets[0]!.id,
        versionId: version.id,
        ops: [op],
      });

      const source = {
        Exposure2012: 0.8,
        Contrast2012: 20,
        Temperature: 6100,
        Tint: -5,
        GrainAmount: 12,
        crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 0 },
      };
      const updated = await handlers['develop:applySettings']({
        photoIds: targets.map((photo) => photo.id),
        params: source,
        groups: ['whiteBalance', 'basicTone', 'effects'],
      });
      expect(updated.map((photo) => photo.id)).toEqual(targets.map((photo) => photo.id));

      for (const photo of targets) {
        const params = await readEditParams(photo.path, exiftool);
        expect(params).toMatchObject({
          Exposure2012: 0.8,
          Contrast2012: 20,
          Temperature: 6100,
          Tint: -5,
          GrainAmount: 12,
        });
        // Crop was not selected, so the source's crop is not copied.
        expect(params.crop).toBeUndefined();
      }
      // An unselected group keeps what the target already had.
      expect((await readEditParams(targets[0]!.path, exiftool)).Saturation).toBe(30);
      // Retouch is never part of a develop settings copy.
      expect(await handlers['retouch:get']({ photoId: targets[0]!.id })).toEqual([op]);
    });

    it('persists tag and colour class in the index and the sidecar', async () => {
      const raw = bySource(cardA)[0]!;
      const [updated] = await handlers['photos:setLabels']({
        photoIds: [raw.id],
        tagged: true,
        colorClass: 3,
      });
      expect(updated).toMatchObject({ tagged: true, colorClass: 3 });
      expect(
        await handlers['photos:get']({ photoId: raw.id }).then((photo) => ({
          tagged: photo.tagged,
          colorClass: photo.colorClass,
        })),
      ).toEqual({ tagged: true, colorClass: 3 });

      const tags = await exiftool.read(raw.sidecarPath);
      expect(String(tags['XMP-photomech:Tagged'])).toMatch(/yes|true/i);
      expect(String(tags['XMP-photomech:ColorClass'])).toMatch(/^3\b/);
      expect(String(tags['XMP-photomech:Prefs'])).toMatch(/Tagged:1, ColorClass:3/);
      expect(String(tags['XMP-xmp:Label'])).toBe('Superior');
      expect(await readPhotoLabels(raw.path, { service: exiftool })).toEqual({
        tagged: true,
        colorClass: 3,
      });

      const jpeg = bySource(cardB).find((photo) => photo.fileName.endsWith('.jpg'));
      if (jpeg) {
        const [cleared] = await handlers['photos:setLabels']({
          photoIds: [jpeg.id],
          tagged: false,
          colorClass: 0,
        });
        expect(cleared).toMatchObject({ tagged: false, colorClass: 0 });
        expect(await readPhotoLabels(jpeg.path, { service: exiftool })).toEqual({
          tagged: false,
          colorClass: 0,
        });
      }
      await expect(
        handlers['photos:setLabels']({ photoIds: [raw.id], colorClass: 12 }),
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    });

    it('deletes a retouch version but never the develop version', async () => {
      const photo = bySource(cardA)[1]!;
      const created = await handlers['photos:createVersion']({
        photoId: photo.id,
        kind: 'retouch',
      });
      const after = await handlers['photos:deleteVersion']({
        photoId: photo.id,
        versionId: created.id,
      });
      expect(after.versions.some((version) => version.id === created.id)).toBe(false);
      await expect(
        handlers['photos:deleteVersion']({
          photoId: photo.id,
          versionId: photo.versions[0]!.id,
        }),
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    });

    it('stores retouch versions in the sidecar (ee:)', async () => {
      const photo = bySource(cardA)[1]!;
      const mosaic = {
        type: 'mosaic' as const,
        shapes: [{ type: 'rect' as const, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
        blockSizeRel: 0.01,
      };
      await handlers['retouch:set']({ photoId: photo.id, ops: [mosaic] });
      expect(await handlers['retouch:get']({ photoId: photo.id })).toEqual([mosaic]);
      const created = await handlers['photos:createVersion']({
        photoId: photo.id,
        kind: 'retouch',
        name: 'B',
      });
      expect(created).toMatchObject({ kind: 'retouch', name: 'B', ops: [] });
      expect(await handlers['retouch:get']({ photoId: photo.id, versionId: created.id })).toEqual(
        [],
      );
      const versions = (await handlers['photos:get']({ photoId: photo.id })).versions;
      expect(versions.map((v) => v.kind)).toEqual(['develop', 'retouch', 'retouch']);
      await expect(
        handlers['photos:createVersion']({ photoId: photo.id, kind: 'develop' }),
      ).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    });

    it.skipIf(!hasFaceFixtures())('detects faces in a JPEG, honouring the region', async () => {
      const jpeg = bySource(cardB).find((p) => p.fileName.endsWith('.jpg'))!;
      const all = await handlers['retouch:detectFaces']({ photoId: jpeg.id });
      expect(all.length).toBeGreaterThan(0);
      const none = await handlers['retouch:detectFaces']({
        photoId: jpeg.id,
        region: { type: 'rect', x: 0, y: 0, w: 0.01, h: 0.01 },
      });
      expect(none).toHaveLength(0);
    });

    it('detects faces through the embedded preview of a raw', async () => {
      if (!hasFaceFixtures()) return;
      const raw = bySource(cardB)[0]!;
      await expect(handlers['retouch:detectFaces']({ photoId: raw.id })).resolves.toBeInstanceOf(
        Array,
      );
    });

    it('exports a rendered image to an FTP destination with IPTC and no embedded preview', async () => {
      const destination: FtpDestination = {
        id: asDestinationId('desk'),
        name: 'Desk',
        kind: 'ftp',
        host: '127.0.0.1',
        port: destServer.port,
        username: 'desk',
        credentialRef: 'dest-ftp',
        security: 'none',
        remotePathTemplate: '/incoming/{fileName}',
      };
      await handlers['destinations:save']({ destination });
      expect(await handlers['destinations:test']({ destination })).toMatchObject({ ok: true });
      const preset = testPreset({
        id: asPresetId('ftp-preset'),
        folderTemplate: join(root, 'ftp-exports'),
        sendTo: [destination.id],
      });
      await handlers['exportPresets:save']({ preset });

      const photo = bySource(cardB)[0]!;
      const rgba = new Uint8Array(640 * 427 * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = (i / 4) % 256;
        rgba[i + 1] = 90;
        rgba[i + 2] = 200;
        rgba[i + 3] = 255;
      }
      const job = await runExportJob(
        handlers,
        { photoIds: [photo.id], presetId: preset.id },
        () => ({ width: 640, height: 427, rgba }),
      );
      expect(job.state).toBe('done');
      expect(job.photos[0]?.state).toBe('done');
      const resultPath = job.photos[0]!.path!;
      expect(resultPath.endsWith('cardB_001.jpg')).toBe(true);

      await assertNoEmbeddedPreviews(resultPath);
      expect(await readIptc(resultPath, exiftool)).toMatchObject({
        byline: 'Jane Doe',
        credit: 'Test Agency',
      });
      expect(await readdir(join(resultPath, '..'))).toEqual(['cardB_001.jpg']);

      const done = await waitFor('the upload to finish', async () => {
        const items: UploadItem[] = await handlers['upload:list']();
        return items.every((item) => item.state === 'done') ? items : undefined;
      });
      expect(done).toHaveLength(1);

      const uploaded = join(destServer.root, 'incoming', 'cardB_001.jpg');
      await assertNoEmbeddedPreviews(uploaded);
      const sentFields = await readIptc(uploaded, exiftool);
      expect(sentFields.caption).toBe(
        (await handlers['metadata:read']({ photoId: photo.id })).caption,
      );
      expect(sentFields).toMatchObject({
        byline: 'Jane Doe',
        city: 'Stockholm',
        keywords: ['football', 'derby'],
      });
      expect((await sharp(uploaded).metadata()).width).toBe(640);

      const final = await handlers['photos:get']({ photoId: photo.id });
      expect(final.status).toMatchObject({ export: 'done', upload: 'done' });
      expect(
        events.some(
          (e) =>
            e.channel === 'jobs:event' && (e.payload as { type: string }).type === 'upload.state',
        ),
      ).toBe(true);
    }, 120_000);

    it('refuses a render that does not carry the current retouch ops', async () => {
      const photo = bySource(cardA)[0]!;
      const version = await handlers['photos:createVersion']({
        photoId: photo.id,
        kind: 'retouch',
      });
      await handlers['retouch:set']({
        photoId: photo.id,
        versionId: version.id,
        ops: [
          {
            type: 'mosaic',
            shapes: [{ type: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.2 }],
            blockSizeRel: 0.01,
          },
        ],
      });
      const preset = testPreset({
        id: asPresetId('ops-key-preset'),
        folderTemplate: join(root, 'ops-key-exports'),
        metadata: 'none',
        version: 'top',
        sendTo: [],
      });
      await handlers['exportPresets:save']({ preset });

      const job = await runExportJob(
        handlers,
        { photoIds: [photo.id], presetId: preset.id },
        () => ({ width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(180) }),
        () => '',
      );
      expect(job.state).toBe('failed');
      expect(job.photos[0]?.state).toBe('failed');
      expect(job.photos[0]?.error).toMatch(/retouch version/);
    });

    it('fails one photo without killing the batch and rejects an unknown preset', async () => {
      const [photo, second] = bySource(cardA);
      if (!photo || !second) throw new Error('expected two cardA photos');
      const preset = testPreset({
        id: asPresetId('batch-preset'),
        folderTemplate: join(root, 'batch-exports'),
        sendTo: [],
      });
      await handlers['exportPresets:save']({ preset });
      const job = await runExportJob(
        handlers,
        { photoIds: [photo.id, second.id], presetId: preset.id },
        (photoId) =>
          photoId === photo.id
            ? { width: 10, height: 10, rgba: new Uint8Array(4) }
            : { width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(180) },
      );
      expect(job.state).toBe('failed');
      expect(job.photos[0]?.state).toBe('failed');
      expect(job.photos[1]?.state).toBe('done');

      await expect(
        handlers['export:start']({ photoIds: [photo.id], presetId: asPresetId('ghost') }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
    it('reports ingest status, tests sources, and a second run skips files already ingested', async () => {
      const status = await handlers['ingest:status']();
      expect(status.find((job) => job.sourceId === cardA)).toMatchObject({
        state: 'finished',
        filesDone: 2 + userNefs.length,
      });
      // Remote sources keep polling until stopped.
      expect(status.find((job) => job.sourceId === ftp)).toMatchObject({
        state: 'watching',
        filesDone: 2,
      });

      expect(await handlers['sources:test']({ source: ftpSource() })).toMatchObject({ ok: true });
      expect(
        await handlers['sources:test']({ source: { ...ftpSource(), credentialRef: 'missing' } }),
      ).toMatchObject({ ok: false });
      expect(
        await handlers['sources:test']({
          source: { id: cardA, name: 'cardA', kind: 'folder', path: join(root, 'a') },
        }),
      ).toMatchObject({ ok: true });
      expect(await handlers['sources:detectCards']()).toBeInstanceOf(Array);

      const count = added().length;
      const mark = events.length;
      await handlers['ingest:start']({ config: ingestConfig });
      // The per-file hook runs before a source reports `finished`, so no photo can arrive after this.
      await waitFor('the rerun to finish', () =>
        events.slice(mark).some((e) => {
          const event = e.payload as { type?: string; sourceId?: string; state?: string };
          return (
            e.channel === 'jobs:event' &&
            event.type === 'ingest.state' &&
            event.sourceId === cardA &&
            event.state === 'finished'
          );
        }),
      );
      expect(added()).toHaveLength(count);

      await handlers['ingest:stop']();
      expect((await handlers['ingest:status']()).find((job) => job.sourceId === ftp)?.state).toBe(
        'stopped',
      );
    });

    it('delivers to folder destinations and surfaces failed uploads, retry and cancel', async () => {
      const folder: FolderDestination = {
        id: asDestinationId('folder'),
        name: 'Folder',
        kind: 'folder',
        path: join(root, 'folder-dest'),
        remotePathTemplate: '{filenamebase}-{event}.jpg',
      };
      const broken: FtpDestination = {
        id: asDestinationId('broken'),
        name: 'Broken',
        kind: 'ftp',
        host: '127.0.0.1',
        port: destServer.port,
        username: 'desk',
        credentialRef: 'no-such-credential',
        security: 'none',
        remotePathTemplate: '/incoming/{fileName}',
      };
      await handlers['destinations:save']({ destination: folder });
      await handlers['destinations:save']({ destination: broken });
      expect(await handlers['destinations:test']({ destination: broken })).toMatchObject({
        ok: false,
      });

      const photo = bySource(cardA)[0]!;
      await handlers['metadata:write']({ photoId: photo.id, fields: { event: 'Derby' } });
      const rendered = { width: 32, height: 32, rgba: new Uint8Array(32 * 32 * 4).fill(200) };
      const preset = testPreset({
        id: asPresetId('folder-preset'),
        folderTemplate: join(root, 'folder-exports'),
        quality: 80,
        metadata: 'iptc',
        sendTo: [folder.id, broken.id],
      });
      await handlers['exportPresets:save']({ preset });
      const job = await runExportJob(
        handlers,
        { photoIds: [photo.id], presetId: preset.id },
        () => rendered,
      );
      expect(job.photos[0]?.state).toBe('done');

      const settled = await waitFor('both uploads to settle', async () => {
        const items = await handlers['upload:list']();
        const mine = items.filter((item) => item.photoId === photo.id);
        return mine.length === 2 && mine.every((i) => i.state === 'done' || i.state === 'failed')
          ? mine
          : undefined;
      });
      // Path templates see the photo's IPTC fields.
      const delivered = join(root, 'folder-dest', 'cardA_001-Derby.jpg');
      expect(settled.find((i) => i.destinationId === folder.id)?.state).toBe('done');
      expect((await stat(delivered)).isFile()).toBe(true);
      const failed = settled.find((i) => i.destinationId === broken.id)!;
      expect(failed.state).toBe('failed');
      expect(failed.error).toContain('no-such-credential');
      expect(failed.error).not.toContain('dest-secret');
      expect((await handlers['photos:get']({ photoId: photo.id })).status.upload).toBe('failed');

      const retryMark = events.length;
      await handlers['upload:retry']({ uploadId: failed.id });
      await waitFor('the retry to fail again', () =>
        events.slice(retryMark).some((e) => {
          const event = e.payload as { type?: string; uploadId?: string; state?: string };
          return (
            event.type === 'upload.state' &&
            event.uploadId === failed.id &&
            event.state === 'failed'
          );
        }),
      );
      await handlers['upload:cancel']({ uploadId: failed.id });
      expect((await handlers['upload:list']()).find((i) => i.id === failed.id)?.state).toBe(
        'cancelled',
      );
      expect((await handlers['photos:get']({ photoId: photo.id })).status.upload).toBe('done');
      await expect(handlers['upload:retry']({ uploadId: 'nope' as never })).rejects.toMatchObject({
        code: 'not_found',
      });
    }, 120_000);

    it('persists settings, sources and destinations as JSON', async () => {
      const saved = await handlers['sources:save']({
        source: { id: asSourceId('x'), name: 'X', kind: 'folder', path: root },
      });
      expect((await handlers['sources:list']()).map((s) => s.id)).toContain(saved.id);
      const file = JSON.parse(await readFile(backend.layout.settingsFile, 'utf8'));
      expect(file.sources.map((s: SourceConfig) => s.id)).toContain('x');
      expect(file.destinations.map((d: FtpDestination) => d.id)).toContain('desk');
      expect(file.exportPresets.length).toBeGreaterThan(0);
      expect(file.exportRoot).toBeTruthy();
      expect(JSON.stringify(file)).not.toContain('secret');
      await handlers['sources:remove']({ sourceId: saved.id });
      await expect(
        handlers['settings:set']({ ingest: { bogus: true } as never }),
      ).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    });
  },
);
