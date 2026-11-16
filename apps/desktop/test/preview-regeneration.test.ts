// @vitest-environment node
import { asSourceId, type IpcHandlers, type Photo } from '@ee/contracts';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function start(): Promise<{
  source: string;
  backend: Backend;
  handlers: IpcHandlers;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ee-preview-'));
  dirs.push(root);
  const source = join(root, 'card');
  const destination = join(root, 'ingest');
  const backup = join(root, 'backup');
  for (const dir of [source, destination, backup]) await mkdir(dir, { recursive: true });
  const backend = await createBackend({
    userDataDir: join(root, 'userdata'),
    appVersion: 'test',
    homeDir: root,
    emit: () => undefined,
    getSecret: async () => ({}),
  });
  const handlers = backend.handlers as IpcHandlers;
  const { ingest } = await handlers['settings:get']();
  await handlers['settings:set']({
    ingest: { ...ingest, destination: { path: destination }, backupDestination: { path: backup } },
  });
  await backend.reconciled;
  return { source, backend, handlers };
}

async function ingestOne(source: string, handlers: IpcHandlers): Promise<Photo> {
  const path = join(source, 'a.jpg');
  await sharp({ create: { width: 80, height: 60, channels: 3, background: '#468' } })
    .jpeg()
    .toFile(path);
  const { ingest } = await handlers['settings:get']();
  await handlers['ingest:start']({
    config: {
      ...ingest,
      sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: source }],
    },
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const photos = await handlers['photos:list']();
    const runs = await handlers['ingest:status']();
    if (
      photos.length === 1 &&
      runs.every((run) => run.state === 'finished' || run.state === 'failed')
    ) {
      await handlers['photos:list']();
      return photos[0]!;
    }
    await sleep(25);
  }
  throw new Error('ingest did not finish');
}

const missing = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
};

describe('a preview cache file that was evicted', { timeout: 30_000 }, () => {
  it('is made again from the photo on disk when the grid asks for it', async () => {
    const harness = await start();
    try {
      const photo = await ingestOne(harness.source, harness.handlers);
      const thumb = harness.backend.layout.thumbDir;
      const file = join(thumb, `${photo.id}.jpg`);
      await rm(file);
      expect(await missing(file)).toBe(true);

      const response = await harness.backend.resolveAppRequest(`app://thumb/${photo.id}`);

      expect(response.status).toBe(200);
      expect(response.file).toBe(file);
      expect((await stat(file)).size).toBeGreaterThan(0);
    } finally {
      await harness.backend.dispose();
    }
  });

  it('never serves the camera thumbnail for a retouched photo; its placeholder waits for a render', async () => {
    const harness = await start();
    try {
      const photo = await ingestOne(harness.source, harness.handlers);
      await harness.handlers['retouch:set']({
        photoId: photo.id,
        ops: [
          {
            type: 'mosaic',
            shapes: [{ type: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.2 }],
            blockSizeRel: 0.01,
          },
        ],
      });
      const thumb = harness.backend.layout.thumbDir;
      await rm(join(thumb, `${photo.id}.jpg`));

      const response = await harness.backend.resolveAppRequest(`app://thumb/${photo.id}`);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.file?.endsWith('_placeholder.jpg')).toBe(true);
      expect(await missing(join(thumb, `${photo.id}.jpg`))).toBe(true);
    } finally {
      await harness.backend.dispose();
    }
  });
});
