// @vitest-environment node
import {
  asPresetId,
  asSourceId,
  type IngestConfig,
  type IpcHandlers,
  type IptcFields,
  type Photo,
  type TemplateApplyMode,
} from '@ee/contracts';
import {
  ensureXmpFile,
  readEditParams,
  readIptc,
  writeEditParams,
  writeIptc,
  ExifToolService,
} from '@ee/metadata';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { copyInto, fixtureNefs, repoRoot } from './helpers/fixtures';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-ingest-preset-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Collected {
  channel: string;
  payload: unknown;
}

interface Harness {
  backend: Backend;
  handlers: IpcHandlers;
  source: string;
  destination: string;
  events: Collected[];
}

async function makeHarness(root: string): Promise<Harness> {
  const source = join(root, 'card');
  const destination = join(root, 'ingest');
  const userData = join(root, 'userdata');
  for (const dir of [source, destination, userData]) await mkdir(dir, { recursive: true });
  const events: Collected[] = [];
  const backend = await createBackend({
    userDataDir: userData,
    appVersion: 'test',
    homeDir: root,
    emit: (channel, payload) => events.push({ channel, payload }),
    getSecret: async () => ({}),
  });
  return { backend, handlers: backend.handlers as IpcHandlers, source, destination, events };
}

const jpeg = (path: string): Promise<unknown> =>
  sharp({ create: { width: 80, height: 60, channels: 3, background: '#468' } })
    .jpeg()
    .toFile(path);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function ingest(
  harness: Harness,
  config: Omit<IngestConfig, 'sources'>,
  expected: number,
): Promise<Photo[]> {
  await harness.handlers['ingest:start']({
    config: {
      ...config,
      sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: harness.source }],
    },
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const photos = await harness.handlers['photos:list']();
    const runs = await harness.handlers['ingest:status']();
    const settled = runs.every((run) => run.state === 'finished' || run.state === 'failed');
    if (photos.length >= expected && settled) return photos;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${expected} photo(s); have ${photos.length}, runs ${JSON.stringify(runs)}`,
      );
    }
    await sleep(50);
  }
}

async function writeTemplate(
  path: string,
  fields: IptcFields,
  service: ExifToolService,
): Promise<string> {
  await ensureXmpFile(path);
  await writeIptc(path, fields, { service });
  return path;
}

const presetPath = join(repoRoot, 'apps/desktop/test/fixtures/poc-preset.xmp');

describe('ingest metadata template and develop preset', { timeout: 120_000 }, () => {
  it('replaces an existing caption in replace mode and keeps it in fillEmpty mode', async () => {
    const service = new ExifToolService();
    try {
      for (const [mode, caption] of [
        ['replace', 'Template caption'],
        ['fillEmpty', 'Old caption'],
      ] as const satisfies readonly [TemplateApplyMode, string][]) {
        const root = await tempDir();
        const harness = await makeHarness(root);
        try {
          const file = join(harness.source, 'frame.jpg');
          await jpeg(file);
          await writeIptc(file, { caption: 'Old caption', instructions: 'Keep me' }, { service });
          const template = await writeTemplate(
            join(root, 'template.XMP'),
            { caption: 'Template caption', city: 'Stockholm' },
            service,
          );

          const [photo] = await ingest(
            harness,
            {
              destination: { path: harness.destination },
              renameTemplate: '{filenamebase}',
              metadataTemplatePath: template,
              metadataTemplateMode: mode,
              codeReplacementPaths: [],
            },
            1,
          );
          const fields = await harness.handlers['metadata:read']({ photoId: photo!.id });
          expect(fields.caption).toBe(caption);
          expect(fields.city).toBe('Stockholm');
          expect(fields.instructions).toBe('Keep me');
        } finally {
          await harness.backend.dispose();
        }
      }
    } finally {
      await service.close();
    }
  });

  it('replaces camera-written copyright and artist in EXIF, XMP and IPTC', async () => {
    const service = new ExifToolService();
    try {
      const root = await tempDir();
      const harness = await makeHarness(root);
      try {
        const file = join(harness.source, 'frame.jpg');
        await jpeg(file);
        await service.write(file, {
          'EXIF:Artist': 'Camera Artist',
          'EXIF:Copyright': 'Camera Copyright',
          'XMP-dc:Creator': 'Camera Artist',
          'XMP-dc:Rights': 'Camera Copyright',
          'IPTC:By-line': 'Camera Artist',
          'IPTC:CopyrightNotice': 'Camera Copyright',
        });
        const template = await writeTemplate(
          join(root, 'template.XMP'),
          { byline: 'Template Photographer', copyright: '© Sportfotografen' },
          service,
        );

        const [photo] = await ingest(
          harness,
          {
            destination: { path: harness.destination },
            renameTemplate: '{filenamebase}',
            metadataTemplatePath: template,
            metadataTemplateMode: 'replace',
            codeReplacementPaths: [],
          },
          1,
        );

        const tags = await service.read(photo!.path);
        expect(tags['IFD0:Artist']).toBe('Template Photographer');
        expect(tags['IFD0:Copyright']).toBe('© Sportfotografen');
        expect(tags['XMP-dc:Creator']).toEqual(['Template Photographer']);
        expect(tags['XMP-dc:Rights']).toBe('© Sportfotografen');
        expect(tags['IPTC:By-line']).toBe('Template Photographer');
        expect(tags['IPTC:CopyrightNotice']).toBe('© Sportfotografen');
      } finally {
        await harness.backend.dispose();
      }
    } finally {
      await service.close();
    }
  });

  it('replaces camera-written values in an existing raw sidecar without touching the raw', async () => {
    const nefs = fixtureNefs();
    if (nefs.length === 0) return;
    const service = new ExifToolService();
    try {
      const root = await tempDir();
      const harness = await makeHarness(root);
      try {
        const nef = join(harness.source, 'frame.NEF');
        copyInto(nefs[0]!, nef);
        const sourceSidecar = nef.replace(/\.NEF$/, '.xmp');
        await ensureXmpFile(sourceSidecar);
        await writeIptc(
          sourceSidecar,
          { byline: 'Camera Artist', copyright: 'Camera Copyright' },
          { service },
        );
        const template = await writeTemplate(
          join(root, 'template.XMP'),
          { byline: 'Template Photographer', copyright: '© Sportfotografen' },
          service,
        );

        const [photo] = await ingest(
          harness,
          {
            destination: { path: harness.destination },
            renameTemplate: '{filenamebase}',
            metadataTemplatePath: template,
            metadataTemplateMode: 'replace',
            codeReplacementPaths: [],
          },
          1,
        );

        const sidecarTags = await service.read(photo!.sidecarPath);
        expect(sidecarTags['XMP-dc:Creator']).toEqual(['Template Photographer']);
        expect(sidecarTags['XMP-dc:Rights']).toBe('© Sportfotografen');
        expect(await readIptc(photo!.path, service)).toMatchObject({
          byline: 'Template Photographer',
          copyright: '© Sportfotografen',
        });
      } finally {
        await harness.backend.dispose();
      }
    } finally {
      await service.close();
    }
  });

  it('applies a develop preset to raws (sidecar) and JPEGs (embedded) and marks them edited', async () => {
    const nefs = fixtureNefs();
    if (nefs.length === 0) return;
    const service = new ExifToolService();
    try {
      const root = await tempDir();
      const harness = await makeHarness(root);
      try {
        copyInto(nefs[0]!, join(harness.source, 'frame.NEF'));
        await jpeg(join(harness.source, 'frame.jpg'));
        const preset = await harness.handlers['develop:importPreset']({ path: presetPath });

        const photos = await ingest(
          harness,
          {
            destination: { path: harness.destination },
            renameTemplate: '{filenamebase}',
            developPresetId: preset.id,
            codeReplacementPaths: [],
          },
          2,
        );
        for (const photo of photos) {
          expect(photo.status.edited).toBe(true);
          expect(photo.previewStale).toBe(true);
          const params = await readEditParams(photo.path, service);
          expect(params).toMatchObject({
            Exposure2012: 0.35,
            Contrast2012: 24,
            Highlights2012: -18,
            Shadows2012: 16,
            Vibrance: 14,
            Saturation: 4,
          });
        }
        const raw = photos.find((photo) => photo.fileName.endsWith('.NEF'))!;
        expect(raw.sidecarPath).toBeDefined();
        expect(await readEditParams(raw.path, service)).toMatchObject({ Exposure2012: 0.35 });
      } finally {
        await harness.backend.dispose();
      }
    } finally {
      await service.close();
    }
  });

  it('does not overwrite develop settings the photo arrived with, and warns once', async () => {
    const nefs = fixtureNefs();
    if (nefs.length === 0) return;
    const service = new ExifToolService();
    try {
      const root = await tempDir();
      const harness = await makeHarness(root);
      try {
        const nef = join(harness.source, 'frame.NEF');
        copyInto(nefs[0]!, nef);
        await writeEditParams(nef, { Exposure2012: 1.2, Contrast2012: 30 }, { service });
        const preset = await harness.handlers['develop:importPreset']({ path: presetPath });

        const [photo] = await ingest(
          harness,
          {
            destination: { path: harness.destination },
            renameTemplate: '{filenamebase}',
            developPresetId: preset.id,
            codeReplacementPaths: [],
          },
          1,
        );

        expect(await readEditParams(photo!.path, service)).toMatchObject({
          Exposure2012: 1.2,
          Contrast2012: 30,
        });
        const warnings = harness.events.filter((event) => {
          const payload = event.payload as { type?: string; scope?: string };
          return (
            event.channel === 'jobs:event' &&
            payload.type === 'job.error' &&
            payload.scope === 'develop preset'
          );
        });
        expect(warnings).toHaveLength(1);
      } finally {
        await harness.backend.dispose();
      }
    } finally {
      await service.close();
    }
  });

  it('continues when the configured preset was deleted and warns once per job', async () => {
    const service = new ExifToolService();
    try {
      const root = await tempDir();
      const harness = await makeHarness(root);
      try {
        await jpeg(join(harness.source, 'a.jpg'));
        await jpeg(join(harness.source, 'b.jpg'));

        const photos = await ingest(
          harness,
          {
            destination: { path: harness.destination },
            renameTemplate: '{filenamebase}',
            developPresetId: asPresetId('deleted-preset'),
            codeReplacementPaths: [],
          },
          2,
        );
        expect(photos).toHaveLength(2);
        for (const photo of photos) {
          expect(photo.status.edited).toBe(false);
          expect(await harness.handlers['develop:getParams']({ photoId: photo.id })).toEqual({});
        }
        const warnings = harness.events.filter((event) => {
          const payload = event.payload as { type?: string; scope?: string; message?: string };
          return (
            event.channel === 'jobs:event' &&
            payload.type === 'job.error' &&
            payload.scope === 'develop preset' &&
            payload.message?.includes('no longer exists')
          );
        });
        expect(warnings).toHaveLength(1);
      } finally {
        await harness.backend.dispose();
      }
    } finally {
      await service.close();
    }
  });
});
