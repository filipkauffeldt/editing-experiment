// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiskCache } from '../src/jobs/backend/disk-cache';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function cacheDirs(): Promise<{ root: string; thumb: string; preview: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ee-cache-'));
  dirs.push(root);
  const thumb = join(root, 'thumb');
  const preview = join(root, 'preview');
  await writeFile(join(root, '.keep'), '');
  await mkdir(thumb, { recursive: true });
  await mkdir(preview, { recursive: true });
  return { root, thumb, preview };
}

const old = new Date('2020-01-02T03:04:05Z');

async function file(path: string, bytes: number): Promise<void> {
  await writeFile(path, Buffer.alloc(bytes, 1));
  await utimes(path, old, old);
}

const entries = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

describe('thumbnail and preview cache limit', () => {
  it('evicts previews before thumbnails, oldest first, and keeps the bytes under the limit', async () => {
    const { thumb, preview } = await cacheDirs();
    await file(join(thumb, 'a.jpg'), 1_000);
    await file(join(preview, 'b.jpg'), 2_000);
    await file(join(thumb, 'c.jpg'), 3_000);
    const cache = new DiskCache({ thumb, preview }, 4_000, () => undefined, {
      protectMs: 0,
      scanDelayMs: 0,
    });
    cache.init();
    await cache.ready();

    // 6,000 bytes, limit 4,000: the 2,000 byte preview goes, both thumbnails stay.
    expect(await entries(preview)).toEqual([]);
    expect(await entries(thumb)).toEqual(['a.jpg', 'c.jpg']);
    expect(cache.stats()).toMatchObject({ thumbBytes: 4_000, previewBytes: 0, limitBytes: 4_000 });
    await cache.close();
  });

  it('drops thumbnails only after every preview is gone', async () => {
    const { thumb, preview } = await cacheDirs();
    await file(join(preview, 'big.jpg'), 5_000);
    await file(join(thumb, 'old.jpg'), 1_000);
    await file(join(thumb, 'new.jpg'), 1_000);
    const cache = new DiskCache({ thumb, preview }, 500, () => undefined, {
      protectMs: 0,
      scanDelayMs: 0,
    });
    cache.init();
    await cache.ready();

    expect(await entries(preview)).toEqual([]);
    expect(await entries(thumb)).toEqual([]);
    expect(cache.stats().bytes).toBe(0);
    await cache.close();
  });

  it('remembers use across a restart so the next eviction drops what was not shown', async () => {
    const { thumb, preview } = await cacheDirs();
    await file(join(thumb, 'a.jpg'), 1_000);
    await file(join(thumb, 'b.jpg'), 1_000);
    await file(join(preview, 'p.jpg'), 1_000);
    const first = new DiskCache({ thumb, preview }, 10_000, () => undefined, {
      protectMs: 0,
      scanDelayMs: 0,
    });
    first.init();
    await first.ready();
    first.touch(join(thumb, 'b.jpg'));
    await first.close();

    // 3,000 bytes now, limit 1,000: everything but the touched thumbnail goes.
    const second = new DiskCache({ thumb, preview }, 1_000, () => undefined, {
      protectMs: 0,
      scanDelayMs: 0,
    });
    second.init();
    await second.ready();
    expect(await entries(thumb)).toEqual(['b.jpg']);
    expect(await entries(preview)).toEqual([]);
    await second.close();
  });

  it('clears both cache folders and makes them ready for new files', async () => {
    const { root, thumb, preview } = await cacheDirs();
    await file(join(thumb, 'a.jpg'), 1_000);
    await file(join(preview, 'b.jpg'), 1_000);
    const cache = new DiskCache({ thumb, preview }, 10_000, () => undefined, {
      scanDelayMs: 0,
    });
    cache.init();
    await cache.ready();
    await cache.clear();

    expect(await entries(thumb)).toEqual([]);
    expect(await entries(preview)).toEqual([]);
    expect(cache.stats().bytes).toBe(0);
    expect((await stat(thumb)).isDirectory()).toBe(true);
    expect((await stat(preview)).isDirectory()).toBe(true);
    expect(await entries(root)).not.toContain('cache-usage.json');
    await cache.close();
  });
});
