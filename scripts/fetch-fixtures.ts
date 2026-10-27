// Downloads CC0 Nikon Z NEF samples from raw.pixls.us into fixtures/raw/ (gitignored).
// Usage: pnpm fetch-fixtures [--force]
// Idempotent: files that already exist with the expected checksum are skipped.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';

interface Fixture {
  /** File name under fixtures/raw/. */
  name: string;
  /** Direct download URL on raw.pixls.us (all samples there are CC0). */
  url: string;
  sha256: string;
  bytes: number;
}

// Bodies without High Efficiency RAW, so these are plain lossless/compressed NEFs.
const FIXTURES: readonly Fixture[] = [
  {
    name: 'z30_14bit.NEF',
    url: 'https://raw.pixls.us/data/Nikon/Z%2030/NIKON_Z30_14BIT.NEF',
    sha256: 'a952c7baaed05c0f191fa3698262a1a894e54e3799dd34dc1ead0f63cf09e2ca',
    bytes: 27_317_593,
  },
  {
    name: 'z50_DSC_0441.NEF',
    url: 'https://raw.pixls.us/data/Nikon/Z%2050/DSC_0441.NEF',
    sha256: 'b25081cf9adcd51fec020b6d227ff094bc0327cbd26d76bad7e1dee3fb4c034a',
    bytes: 26_472_394,
  },
  {
    name: 'z6ii_CZP_0299.NEF',
    url: 'https://raw.pixls.us/data/Nikon/Z%206_2/CZP_0299.NEF',
    sha256: '1b67d15817dbd4143a1f1089e2f09e319a2a2327c124e2643284509dd7621030',
    bytes: 36_988_625,
  },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'fixtures', 'raw');

async function sha256Of(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function download(fixture: Fixture, destination: string): Promise<void> {
  const response = await fetch(fixture.url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`${fixture.url}: HTTP ${response.status}`);
  }
  // Write to a temp name and rename after verification so a failed run never
  // leaves a truncated file that looks valid.
  const partial = `${destination}.part`;
  const hash = createHash('sha256');
  const source = Readable.fromWeb(response.body as ReadableStream);
  source.on('data', (chunk: Buffer) => hash.update(chunk));
  try {
    await pipeline(source, createWriteStream(partial));
    const actual = hash.digest('hex');
    if (actual !== fixture.sha256) {
      throw new Error(
        `${fixture.name}: checksum mismatch (expected ${fixture.sha256}, got ${actual})`,
      );
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  await mkdir(targetDir, { recursive: true });
  for (const fixture of FIXTURES) {
    const destination = join(targetDir, fixture.name);
    if (!force && (await sha256Of(destination)) === fixture.sha256) {
      console.log(`ok       ${fixture.name}`);
      continue;
    }
    console.log(`fetching ${fixture.name} (${(fixture.bytes / 1e6).toFixed(1)} MB)`);
    await download(fixture, destination);
    console.log(`ok       ${fixture.name}`);
  }
}

await main();
