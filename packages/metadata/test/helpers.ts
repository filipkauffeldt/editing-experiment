import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'raw');

export function fixtureAvailable(name: string): boolean {
  return existsSync(join(FIXTURE_DIR, name));
}

const tempDirs: string[] = [];

export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ee-metadata-'));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function makeJpeg(
  path: string,
  options: { width?: number; height?: number } = {},
): Promise<void> {
  await sharp({
    create: {
      width: options.width ?? 64,
      height: options.height ?? 48,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .jpeg({ quality: 85 })
    .toFile(path);
}

/** Copy a fixture into `dir` so tests never touch the checked-out fixture. */
export async function copyFixture(name: string, dir: string): Promise<string> {
  const destination = join(dir, name);
  await copyFile(join(FIXTURE_DIR, name), destination);
  return destination;
}

export async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * First NEF from `EE_SAMPLE_NEF_DIR` (the user's own Nikon Z 6 shots), or
 * `undefined` when the env var is unset/missing. Tests must skip cleanly.
 */
export async function sampleNefPath(): Promise<string | undefined> {
  const dir = process.env.EE_SAMPLE_NEF_DIR;
  if (dir === undefined || dir === '') return undefined;
  try {
    const entries = await readdir(dir);
    const nef = entries.find((entry) => entry.toLowerCase().endsWith('.nef'));
    return nef === undefined ? undefined : join(dir, nef);
  } catch {
    return undefined;
  }
}
