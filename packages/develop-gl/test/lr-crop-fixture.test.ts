import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CropParams } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { cropAspect, cropOutputPixels } from '../src/crop';

/**
 * Cross-check against a real Lightroom crop. The fixture is not committed;
 * see `fixtures/lr-crop/README.md` for the three files to drop in.
 */
const DIR = join(import.meta.dirname, 'fixtures', 'lr-crop');
const XMP = join(DIR, 'lightroom.xmp');
const ORIGINAL = join(DIR, 'original.json');
const EXPORTED = join(DIR, 'exported.jpg');
const available = existsSync(XMP) && existsSync(ORIGINAL) && existsSync(EXPORTED);

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

describe.skipIf(!available)('Lightroom crop reference', () => {
  it('matches the exported crop dimensions and aspect', () => {
    const xml = readFileSync(XMP, 'utf8');
    const original = JSON.parse(readFileSync(ORIGINAL, 'utf8')) as {
      width: number;
      height: number;
    };
    const exported = jpegSize(readFileSync(EXPORTED));
    const hasCrop = crsAttribute(xml, 'HasCrop');
    if (hasCrop !== undefined) expect(hasCrop.toLowerCase()).toBe('true');

    const crop: CropParams = {
      left: Number(crsAttribute(xml, 'CropLeft')),
      top: Number(crsAttribute(xml, 'CropTop')),
      right: Number(crsAttribute(xml, 'CropRight')),
      bottom: Number(crsAttribute(xml, 'CropBottom')),
      angle: Number(crsAttribute(xml, 'CropAngle') ?? 0),
    };
    for (const value of [crop.left, crop.top, crop.right, crop.bottom, crop.angle]) {
      expect(Number.isFinite(value)).toBe(true);
    }

    const expected = cropOutputPixels(crop, original);
    // Lightroom may round the output by a pixel; the aspect check catches a
    // wrong angle or corner interpretation.
    expect(Math.abs(exported.width - expected.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(exported.height - expected.height)).toBeLessThanOrEqual(2);
    expect(exported.width / exported.height).toBeCloseTo(cropAspect(crop, original), 2);
  });
});
