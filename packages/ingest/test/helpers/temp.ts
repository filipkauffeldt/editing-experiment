import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tracked: string[] = [];

export async function makeTempDir(prefix = 'ee-ingest-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tracked.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
