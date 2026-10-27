import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FaceDetection, Point, Rect } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  decodeImageFile,
  detectFaces,
  defaultModelPath,
  detectFacesInFile,
  intersectionOverUnion,
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
