// Downloads the YuNet model and public-domain face-detection test photos into
// fixtures/models/ and fixtures/retouch/ (both gitignored).
// Usage: pnpm fetch-retouch [--force]
// Idempotent: files that already exist with the expected checksum are skipped.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

interface Download {
  /** File name inside `targetDir`. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  /** Human-readable licence and source page, recorded next to the checksum. */
  licence: string;
  source: string;
}

interface FixtureGroup {
  targetDir: string;
  files: readonly Download[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GROUPS: readonly FixtureGroup[] = [
  {
    targetDir: join(root, 'fixtures', 'models'),
    files: [
      {
        name: 'face_detection_yunet_2026may.onnx',
        url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2026may.onnx',
        sha256: 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0',
        bytes: 229_738,
        licence: 'MIT (Shiqi Yu), packages/retouch/third_party/yunet/LICENSE',
        source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
      },
    ],
  },
  {
    targetDir: join(root, 'fixtures', 'retouch'),
    files: [
      {
        name: 'apollo11_crew.jpg',
        url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3d/Apollo_11_Crew.jpg/3840px-Apollo_11_Crew.jpg',
        sha256: '00fd0dbcc80bf10282c4b4930d8303e21fd75afaf0ad99d7d4003a7f037cef92',
        bytes: 1_573_314,
        licence: 'Public domain (NASA)',
        source: 'https://commons.wikimedia.org/wiki/File:Apollo_11_Crew.jpg',
      },
      {
        name: 'astronaut_group8.jpg',
        url: 'https://upload.wikimedia.org/wikipedia/commons/d/d5/NASA_Astronaut_Group_8.jpg',
        sha256: '8dfc83c2f091341782e17e95ac3c961ab0bac0984247bf157e6ebfc8f3186cb6',
        bytes: 582_882,
        licence: 'Public domain (NASA)',
        source: 'https://commons.wikimedia.org/wiki/File:NASA_Astronaut_Group_8.jpg',
      },
      {
        name: 'suffragette_group.jpg',
        url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/Suffragette_group_LCCN2016828258.jpg/3840px-Suffragette_group_LCCN2016828258.jpg',
        sha256: '835698e4fadfff8064c193e8542ef953ff9eb1d9b61dcc68d9fad6edd091cdac',
        bytes: 1_772_323,
        licence: 'Public domain (Library of Congress, National Photo Company Collection)',
        source: 'https://commons.wikimedia.org/wiki/File:Suffragette_group_LCCN2016828258.jpg',
      },
    ],
  },
];

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

async function download(file: Download, destination: string): Promise<void> {
  const response = await fetch(file.url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`${file.url}: HTTP ${response.status}`);
  }
  const partial = `${destination}.part`;
  const hash = createHash('sha256');
  const source = Readable.fromWeb(response.body as ReadableStream);
  source.on('data', (chunk: Buffer) => hash.update(chunk));
  try {
    await pipeline(source, createWriteStream(partial));
    const actual = hash.digest('hex');
    if (actual !== file.sha256) {
      throw new Error(`${file.name}: checksum mismatch (expected ${file.sha256}, got ${actual})`);
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  for (const group of GROUPS) {
    await mkdir(group.targetDir, { recursive: true });
    for (const file of group.files) {
      const destination = join(group.targetDir, file.name);
      if (!force && (await sha256Of(destination)) === file.sha256) {
        console.log(`ok       ${file.name}`);
        continue;
      }
      console.log(`fetching ${file.name} (${(file.bytes / 1e6).toFixed(1)} MB)`);
      await download(file, destination);
      console.log(`ok       ${file.name} (${file.licence}; ${file.source})`);
    }
  }
}

await main();
