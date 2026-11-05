// @vitest-environment node
import {
  asPresetId,
  asSourceId,
  type IngestConfig,
  type IpcHandlers,
  type Photo,
} from '@ee/contracts';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';

/**
 * Ingest with a develop preset that is a file in a preset folder (not an imported copy): the preset
 * is read when the ingest asks for it, a vanished file never fails the copy, and the folder is only
 * read.
 */

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-ingest-discovered-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const UUID = '00000000-0000-4000-8000-0000000000aa';
const xmp = (exposure: string): string => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Normal" crs:UUID="${UUID}" crs:Exposure2012="${exposure}" crs:Contrast2012="+12">
   <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Kväll</rdf:li></rdf:Alt></crs:Name>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

interface Harness {
  backend: Backend;
  handlers: IpcHandlers;
  source: string;
  destination: string;
  presetFolder: string;
  events: { channel: string; payload: unknown }[];
}

async function makeHarness(root: string): Promise<Harness> {
  const source = join(root, 'card');
  const destination = join(root, 'ingest');
  const userData = join(root, 'userdata');
  const presetFolder = join(root, 'Lightroom Settings');
  for (const dir of [source, destination, userData, join(presetFolder, 'Sport')]) {
    await mkdir(dir, { recursive: true });
  }
  const events: Harness['events'] = [];
  const backend = await createBackend({
    userDataDir: userData,
    appVersion: 'test',
    homeDir: root,
    emit: (channel, payload) => events.push({ channel, payload }),
    getSecret: async () => ({}),
  });
  const handlers = backend.handlers as IpcHandlers;
  await handlers['settings:set']({ presetFolders: [presetFolder] });
  return { backend, handlers, source, destination, presetFolder, events };
}

const jpeg = (path: string): Promise<unknown> =>
  sharp({ create: { width: 80, height: 60, channels: 3, background: '#468' } })
    .jpeg()
    .toFile(path);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function ingest(harness: Harness, config: Omit<IngestConfig, 'sources'>, expected: number) {
  await harness.handlers['ingest:start']({
    config: {
      ...config,
      sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: harness.source }],
    },
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const photos: Photo[] = await harness.handlers['photos:list']();
    const runs = await harness.handlers['ingest:status']();
    const settled = runs.every((run) => run.state === 'finished' || run.state === 'failed');
    if (photos.length >= expected && settled) return { photos, runs };
    if (Date.now() > deadline) throw new Error(`timed out: ${photos.length} photo(s)`);
    await sleep(50);
  }
}

/** Names, bytes, modes and modified times of a tree. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (folder: string): Promise<void> => {
    const info = await stat(folder);
    out[`${relative(root, folder) || '.'}/`] = `${info.mode}:${info.mtimeMs}`;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const file = await stat(path);
        const hash = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
        out[relative(root, path)] = `${file.mode}:${file.mtimeMs}:${file.size}:${hash}`;
      }
    }
  };
  await walk(root);
  return out;
}

const config = (harness: Harness): Omit<IngestConfig, 'sources'> => ({
  destination: { path: harness.destination },
  fileNaming: 'rename',
  renameTemplate: '{filenamebase}',
  developPresetId: asPresetId(UUID),
});

const warnings = (harness: Harness, text: string): number =>
  harness.events.filter((event) => {
    const payload = event.payload as { type?: string; scope?: string; message?: string };
    return (
      event.channel === 'jobs:event' &&
      payload.type === 'job.error' &&
      payload.scope === 'develop preset' &&
      payload.message?.includes(text)
    );
  }).length;

describe('ingest with a preset from a preset folder', { timeout: 120_000 }, () => {
  it('applies the preset as its file is now, and never writes to the preset folder', async () => {
    const harness = await makeHarness(await tempDir());
    try {
      const file = join(harness.presetFolder, 'Sport', 'Kvall.xmp');
      await writeFile(file, xmp('+0.50'));
      // Listed once at start-up; edited afterwards, as Lightroom would.
      await harness.handlers['develop:presetIndex']();
      await writeFile(file, xmp('-1.25'));
      const before = await snapshot(harness.presetFolder);
      await jpeg(join(harness.source, 'a.jpg'));

      const { photos } = await ingest(harness, config(harness), 1);

      const params = await harness.handlers['develop:getParams']({
        photoId: (photos[0] as Photo).id,
      });
      expect(params.Exposure2012).toBe(-1.25);
      expect(params.Contrast2012).toBe(12);
      expect(await snapshot(harness.presetFolder)).toEqual(before);
      // Nothing was copied into the app's own folder either.
      expect(
        await readdir(join(harness.presetFolder, '..', 'userdata')).then((n) =>
          n.includes('presets'),
        ),
      ).toBe(false);
    } finally {
      await harness.backend.dispose();
    }
  });

  it('still copies the photos when the saved preset’s file has vanished, with one warning', async () => {
    const harness = await makeHarness(await tempDir());
    try {
      const file = join(harness.presetFolder, 'Sport', 'Kvall.xmp');
      await writeFile(file, xmp('+0.50'));
      await harness.handlers['develop:presetIndex']();
      await rm(file);
      await jpeg(join(harness.source, 'a.jpg'));
      await jpeg(join(harness.source, 'b.jpg'));

      const { photos, runs } = await ingest(harness, config(harness), 2);

      expect(runs.every((run) => run.state === 'finished')).toBe(true);
      expect(photos).toHaveLength(2);
      for (const photo of photos) {
        expect(photo.status.edited).toBe(false);
        expect(await harness.handlers['develop:getParams']({ photoId: photo.id })).toEqual({});
      }
      expect(warnings(harness, 'no longer exists')).toBe(1);
    } finally {
      await harness.backend.dispose();
    }
  });

  it('applies a preset whose file was added after the app started', async () => {
    const harness = await makeHarness(await tempDir());
    try {
      await harness.handlers['develop:presetIndex']();
      await writeFile(join(harness.presetFolder, 'Sport', 'Ny.xmp'), xmp('+0.75'));
      await jpeg(join(harness.source, 'a.jpg'));

      const { photos } = await ingest(harness, config(harness), 1);

      const params = await harness.handlers['develop:getParams']({
        photoId: (photos[0] as Photo).id,
      });
      expect(params.Exposure2012).toBe(0.75);
    } finally {
      await harness.backend.dispose();
    }
  });
});

describe('the preset list of the backend', { timeout: 60_000 }, () => {
  it('lists discovered presets with their group, drops a removed file on rescan, and reports problems', async () => {
    const harness = await makeHarness(await tempDir());
    try {
      const file = join(harness.presetFolder, 'Sport', 'Kvall.xmp');
      const bad = join(harness.presetFolder, 'Trasig.xmp');
      await writeFile(file, xmp('+0.50'));
      await writeFile(bad, '<broken');

      const first = await harness.handlers['develop:presetIndex']({ rescan: true });
      expect(first.presets.map((p) => [p.group, p.name])).toEqual([['Sport', 'Kväll']]);
      expect(first.problems.map((p) => p.path)).toEqual([bad]);
      expect(first.folders).toEqual([harness.presetFolder]);

      await rm(file);
      const second = await harness.handlers['develop:presetIndex']({ rescan: true });
      expect(second.presets).toEqual([]);
    } finally {
      await harness.backend.dispose();
    }
  });
});
