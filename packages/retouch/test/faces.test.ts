import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FaceDetection, Point, Rect } from '@ee/contracts';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  decodeImageFile,
  detectFaces,
  defaultModelPath,
  detectFacesInFile,
  intersectionOverUnion,
  mergeOverlappingDetections,
  nonMaximumSuppression,
  YUNET_MODEL_FILE,
} from '../src/faces/index';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const photoDir = join(root, 'fixtures', 'retouch');
const modelPath = join(root, 'fixtures', 'models', YUNET_MODEL_FILE);
const photos = ['apollo11_crew.jpg', 'astronaut_group8.jpg', 'suffragette_group.jpg'];
const available = existsSync(modelPath) && photos.every((name) => existsSync(join(photoDir, name)));
const suite = available ? describe : describe.skip;
if (!available) console.warn('skipping face tests: run `pnpm fetch-retouch`');

const photo = (name: string): string => join(photoDir, name);

async function upscaledApolloFace(): Promise<{
  rgba: Uint8Array;
  width: number;
  height: number;
}> {
  const image = await decodeImageFile(photo('apollo11_crew.jpg'));
  const left = Math.round(0.15 * image.width);
  const top = Math.round(0.25 * image.height);
  const width = Math.round(0.21 * image.width);
  const height = Math.round(0.3 * image.height);
  const { data, info } = await sharp(Buffer.from(image.rgba), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .extract({ left, top, width, height })
    .resize(1800, 1800)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

function contains(box: Rect, point: Point): boolean {
  return (
    point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
  );
}

suite('YuNet face detection', () => {
  it('resolves the fetched model by default', () => {
    expect(existsSync(defaultModelPath())).toBe(true);
  });

  it('finds the three Apollo 11 crew faces', async () => {
    const image = await decodeImageFile(photo('apollo11_crew.jpg'));
    const faces = await detectFaces(image.rgba, image.width, image.height, undefined, {
      modelPath,
    });
    expect(faces).toHaveLength(3);
    const expectedCentres: Point[] = [
      { x: 0.25, y: 0.42 },
      { x: 0.48, y: 0.23 },
      { x: 0.73, y: 0.43 },
    ];
    for (const centre of expectedCentres) {
      expect(
        faces.some((face) => contains(face.box, centre)),
        `no face at ${centre.x},${centre.y}`,
      ).toBe(true);
    }
    for (const face of faces) {
      expect(face.score).toBeGreaterThan(0.6);
      expect(face.landmarks).toHaveLength(5);
      expect(face.box.w).toBeGreaterThan(0);
      expect(face.box.h).toBeGreaterThan(0);
    }
  });

  it('keeps a face larger than a tile intact via the region-scale pass', async () => {
    const image = await upscaledApolloFace();
    const faces = await detectFaces(
      image.rgba,
      image.width,
      image.height,
      { type: 'rect', x: 0, y: 0, w: 1, h: 1 },
      { modelPath, maxInputEdge: 640 },
    );
    const complete = faces.find((face) => face.box.w > 0.35 && face.box.h > 0.45);
    expect(complete, 'expected a complete detection of the oversized face').toBeDefined();
  });

  it('unions a clipped tile detection with the complete face box', () => {
    const partial = {
      box: { x: 10, y: 10, w: 25, h: 80 },
      score: 0.9,
      landmarks: [],
    };
    const complete = {
      box: { x: 10, y: 10, w: 100, h: 80 },
      score: 0.8,
      landmarks: [],
    };
    const merged = mergeOverlappingDetections([partial, complete], 0.3);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.box).toEqual({ x: 10, y: 10, w: 100, h: 80 });
    expect(merged[0]!.score).toBe(0.9);
  });

  it('covers a face that straddles a tile boundary', async () => {
    const image = await upscaledApolloFace();
    const region = { type: 'rect' as const, x: 0, y: 0, w: 1, h: 1 };
    const full = await detectFaces(image.rgba, image.width, image.height, undefined, {
      modelPath,
      maxInputEdge: 640,
    });
    expect(full).toHaveLength(1);
    const tiled = await detectFaces(image.rgba, image.width, image.height, region, {
      modelPath,
      maxInputEdge: 640,
    });
    expect(tiled).toHaveLength(1);
    const expected = full[0]!.box;
    const actual = tiled[0]!.box;
    expect(actual.x).toBeLessThanOrEqual(expected.x + 0.02);
    expect(actual.y).toBeLessThanOrEqual(expected.y + 0.02);
    expect(actual.x + actual.w).toBeGreaterThanOrEqual(expected.x + expected.w - 0.02);
    expect(actual.y + actual.h).toBeGreaterThanOrEqual(expected.y + expected.h - 0.02);
  });

  it('honours the score threshold', async () => {
    const image = await decodeImageFile(photo('apollo11_crew.jpg'));
    const none = await detectFaces(image.rgba, image.width, image.height, undefined, {
      modelPath,
      scoreThreshold: 0.99,
    });
    expect(none).toHaveLength(0);
  });

  it('finds small faces in a full-resolution region that reduced full-image detection misses', async () => {
    const image = await decodeImageFile(photo('astronaut_group8.jpg'));
    const region: Rect = { type: 'rect', x: 0.2, y: 0.25, w: 0.6, h: 0.6 };
    const reduced = await detectFaces(image.rgba, image.width, image.height, undefined, {
      modelPath,
      maxInputEdge: 400,
    });
    const cropped = await detectFaces(image.rgba, image.width, image.height, region, {
      modelPath,
    });

    expect(reduced.length).toBeLessThanOrEqual(5);
    expect(cropped.length).toBeGreaterThanOrEqual(20);
    expect(cropped.length).toBeGreaterThan(reduced.length);

    const knownFace: Point = { x: 0.353, y: 0.416 };
    expect(cropped.some((face) => contains(face.box, knownFace))).toBe(true);
    expect(reduced.some((face) => contains(face.box, knownFace))).toBe(false);

    for (const face of cropped) {
      expect(face.box.x).toBeGreaterThanOrEqual(0);
      expect(face.box.y).toBeGreaterThanOrEqual(0);
      expect(face.box.x + face.box.w).toBeLessThanOrEqual(1);
      expect(face.box.y + face.box.h).toBeLessThanOrEqual(1);
    }
  });

  it('detects faces in an image file', async () => {
    const faces = await detectFacesInFile(photo('apollo11_crew.jpg'), undefined, { modelPath });
    expect(faces).toHaveLength(3);
  });

  it('merges overlapping boxes with NMS', () => {
    const boxes = [
      { box: { x: 0, y: 0, w: 10, h: 10 }, score: 0.9 },
      { box: { x: 1, y: 1, w: 10, h: 10 }, score: 0.8 },
      { box: { x: 50, y: 50, w: 10, h: 10 }, score: 0.7 },
    ];
    expect(intersectionOverUnion(boxes[0]!.box, boxes[1]!.box)).toBeGreaterThan(0.6);
    const kept = nonMaximumSuppression(boxes, 0.3);
    expect(kept).toHaveLength(2);
    expect(kept[0]!.score).toBe(0.9);
    expect(kept[1]!.score).toBe(0.7);
  });
});

const nefDir = process.env['EE_SAMPLE_NEF_DIR'];
const nefAvailable = Boolean(nefDir && existsSync(nefDir) && available);
const nefSuite = nefAvailable ? describe : describe.skip;
if (nefDir && !nefAvailable) {
  console.warn(`skipping NEF face test: no model/photos or ${nefDir}`);
}

nefSuite('local NEF samples', () => {
  it('detects faces in an extracted preview', async () => {
    const directory = nefDir!;
    const sample = readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith('.nef'))
      .sort()[0];
    if (!sample) return;
    const { extractPreview } = await import('@ee/core');
    const sharp = (await import('sharp')).default;
    const preview = await extractPreview(join(directory, sample));
    const { data, info } = await sharp(preview.jpeg)
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const faces: FaceDetection[] = await detectFaces(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      info.width,
      info.height,
      undefined,
      { modelPath },
    );
    console.log(`${sample} (${info.width}x${info.height}): ${faces.length} faces`);
    for (const face of faces) {
      expect(face.score).toBeGreaterThan(0.6);
      expect(face.box.x).toBeGreaterThanOrEqual(0);
      expect(face.box.y).toBeGreaterThanOrEqual(0);
      expect(face.box.x + face.box.w).toBeLessThanOrEqual(1);
      expect(face.box.y + face.box.h).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
