import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySeenStore, SqliteSeenStore, type SeenFile } from '../src/seen-store';

const base: SeenFile = {
  sourceId: 'source-a',
  path: '/cards/DCIM/100NCZ/_DSC9.NEF',
  size: 1234,
  mtimeMs: 1_700_000_000_000,
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MemorySeenStore', () => {
  it('matches on source, path, size and mtime', () => {
    const store = new MemorySeenStore();
    store.add(base);

    expect(store.has(base)).toBe(true);
    expect(store.has({ ...base, sourceId: 'source-b' })).toBe(false);
    expect(store.has({ ...base, path: '/other.NEF' })).toBe(false);
    expect(store.has({ ...base, size: base.size + 1 })).toBe(false);
    expect(store.has({ ...base, mtimeMs: base.mtimeMs + 1 })).toBe(false);
  });
});

describe('SqliteSeenStore', () => {
  it('persists entries across instances and keeps identities separate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-seen-'));
    tempDirs.push(dir);
    const file = join(dir, 'state', 'ingest.sqlite');

    const first = new SqliteSeenStore(file);
    first.add(base);
    expect(first.has(base)).toBe(true);
    first.close();

    const second = new SqliteSeenStore(file);
    expect(second.has(base)).toBe(true);
    expect(second.has({ ...base, size: base.size + 1 })).toBe(false);
    expect(second.has({ ...base, sourceId: 'source-b' })).toBe(false);
    second.close();
  });
});
