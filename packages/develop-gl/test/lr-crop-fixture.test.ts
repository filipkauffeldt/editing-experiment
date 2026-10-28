import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CropParams } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { cropAspect, cropOutputPixels, cropStoredToOriented } from '../src/crop';

/**
 * Cross-check against real Lightroom crops. The fixtures are not committed;
 * see `fixtures/lr-crop/README.md` for the files to drop in.
 */
const DIR = join(import.meta.dirname, 'fixtures', 'lr-crop');

function crsAttribute(xml: string, name: string): string | undefined {
  return new RegExp(`crs:${name}="([^"]*)"`).exec(xml)?.[1];
}

/** Minimal JPEG SOF parser: width/height without decoding pixels. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG has no SOF marker');
}

for (const name of ['landscape', 'portrait'] as const) {
  const directory = join(DIR, name);
  const xmp = join(directory, 'lightroom.xmp');
  const originalFile = join(directory, 'original.json');
  const exportedFile = join(directory, 'exported.jpg');
  const available = existsSync(xmp) && existsSync(originalFile) && existsSync(exportedFile);

  describe.skipIf(!available)(`Lightroom ${name} crop reference`, () => {
    it('matches the exported crop dimensions and aspect', () => {
      const xml = readFileSync(xmp, 'utf8');
      const original = JSON.parse(readFileSync(originalFile, 'utf8')) as {
        width: number;
        height: number;
        orientation?: number;
      };
      const exported = jpegSize(readFileSync(exportedFile));
      const hasCrop = crsAttribute(xml, 'HasCrop');
      if (hasCrop !== undefined) expect(hasCrop.toLowerCase()).toBe('true');

      const stored: CropParams = {
        left: Number(crsAttribute(xml, 'CropLeft')),
        top: Number(crsAttribute(xml, 'CropTop')),
        right: Number(crsAttribute(xml, 'CropRight')),
        bottom: Number(crsAttribute(xml, 'CropBottom')),
        angle: Number(crsAttribute(xml, 'CropAngle') ?? 0),
      };
      for (const value of [stored.left, stored.top, stored.right, stored.bottom, stored.angle]) {
        expect(Number.isFinite(value)).toBe(true);
      }

      const oriented = cropStoredToOriented(
        stored,
        { width: original.width, height: original.height },
        original.orientation ?? 1,
      );
      const expected = cropOutputPixels(oriented, original);
      // Lightroom may round the output by a pixel; the aspect check catches a
      // wrong angle, corner or orientation interpretation.
      expect(Math.abs(exported.width - expected.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(exported.height - expected.height)).toBeLessThanOrEqual(2);
      expect(exported.width / exported.height).toBeCloseTo(cropAspect(oriented, original), 2);
    });
  });
}
