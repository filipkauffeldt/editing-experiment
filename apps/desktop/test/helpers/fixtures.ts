import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** CC0 NEFs fetched by `pnpm fetch-fixtures`; empty when they were not fetched. */
export function fixtureNefs(): string[] {
  const dir = join(repoRoot, 'fixtures', 'raw');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.nef'))
    .sort()
    .map((name) => join(dir, name));
}

/** The user's own NEFs from `EE_SAMPLE_NEF_DIR` (read only), if set. */
export function sampleNefs(): string[] {
  const dir = process.env.EE_SAMPLE_NEF_DIR;
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.nef'))
    .sort()
    .map((name) => join(dir, name));
}

/** Copy `source` to `destination` (never touches the source). */
export function copyInto(source: string, destination: string): void {
  copyFileSync(source, destination);
}

export const faceJpeg = join(repoRoot, 'fixtures', 'retouch', 'apollo11_crew.jpg');
export const hasFaceFixtures = (): boolean =>
  existsSync(faceJpeg) &&
  existsSync(join(repoRoot, 'fixtures', 'models', 'face_detection_yunet_2026may.onnx'));
