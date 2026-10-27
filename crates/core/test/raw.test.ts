import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeLinear, extractPreview, readRawInfo } from '../src/index';

// Raws come from `pnpm fetch-fixtures` (CC0) and, optionally, EE_SAMPLE_NEF_DIR.
// Without any, the suite skips instead of failing.
const here = dirname(fileURLToPath(import.meta.url));
const roots = [resolve(here, '../../../fixtures/raw'), process.env['EE_SAMPLE_NEF_DIR']];
const samples = roots
  .filter((dir): dir is string => dir !== undefined && existsSync(dir))
  .flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.nef'))
      .sort()
      .map((name) => join(dir, name)),
  );
const fixture = (name: string): string | undefined =>
  samples.find((path) => basename(path) === name);

const slow = 60_000;
const suite = samples.length > 0 ? describe : describe.skip;
if (samples.length === 0) console.warn('skipping raw tests: run `pnpm fetch-fixtures`');

/** IEEE half float to number. */
function halfToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Start-of-frame size of a JPEG, or undefined. */
function jpegSize(jpeg: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return undefined;
    const marker = jpeg[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return undefined;
}

/** Mean of each colour channel of an f32 RGBA buffer. */
function channelMeans(data: Buffer): [number, number, number] {
  const samples = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
  const sums = [0, 0, 0];
  for (let i = 0; i < samples.length; i += 4) {
    sums[0]! += samples[i]!;
    sums[1]! += samples[i + 1]!;
    sums[2]! += samples[i + 2]!;
  }
  const pixels = samples.length / 4;
  return [sums[0]! / pixels, sums[1]! / pixels, sums[2]! / pixels];
}

suite('readRawInfo', () => {
  it('reads camera, exposure and geometry for every sample', async () => {
    for (const path of samples) {
      const info = await readRawInfo(path);
      expect(info.make, path).toBe('Nikon');
      expect(info.model).toMatch(/^Z /);
      expect(info.iso).toBeGreaterThanOrEqual(50);
      expect(info.shutter).toBeGreaterThan(0);
      expect(info.aperture).toBeGreaterThanOrEqual(1);
      expect(info.focalLength).toBeGreaterThan(0);
      expect(info.captureTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(info.orientation).toBeGreaterThanOrEqual(1);
      expect(info.orientation).toBeLessThanOrEqual(8);
      expect(info.rawWidth).toBeGreaterThanOrEqual(info.width);
      expect(info.width).toBeGreaterThan(4000);
      expect(info.height).toBeGreaterThan(3000);
    }
  });

  it('matches the known exposure of the Z 30 sample', async () => {
    const path = fixture('z30_14bit.NEF');
    if (!path) return;
    expect(await readRawInfo(path)).toMatchObject({
      make: 'Nikon',
      model: 'Z 30',
      lens: 'NIKKOR Z 40mm f/2',
      captureTime: '2022-12-06T14:22:57',
      iso: 100,
      aperture: 2,
      focalLength: 40,
      orientation: 1,
      rawWidth: 5600,
      rawHeight: 3728,
    });
  });

  it('matches the known exposure of the Z 6II sample', async () => {
    const path = fixture('z6ii_CZP_0299.NEF');
    if (!path) return;
    const info = await readRawInfo(path);
    expect(info).toMatchObject({ model: 'Z 6_2', iso: 100, aperture: 6, focalLength: 70 });
    expect(info.shutter).toBeCloseTo(1 / 40, 4);
    expect(info.lens).toBe('NIKKOR Z 24-200mm f/4-6.3 VR');
  });

  it('rejects with a clear message for a missing file', async () => {
    await expect(readRawInfo('/no/such/photo.NEF')).rejects.toThrow(/photo\.NEF/);
  });

  it('rejects files that are not raws', async () => {
    await expect(readRawInfo(fileURLToPath(import.meta.url))).rejects.toThrow(/raw|read/i);
  });
});

suite('extractPreview', () => {
  it('returns a valid full-size JPEG with matching dimensions', async () => {
    for (const path of samples) {
      const preview = await extractPreview(path);
      const { jpeg } = preview;
      expect(jpeg.subarray(0, 2).toString('hex'), path).toBe('ffd8');
      expect(jpeg.subarray(-2).toString('hex')).toBe('ffd9');
      expect(preview.width).toBeGreaterThan(4000);
      expect(preview.height).toBeGreaterThan(3000);
      expect(jpegSize(jpeg)).toEqual({ width: preview.width, height: preview.height });
      expect(preview.orientation).toBeGreaterThanOrEqual(1);
      expect(preview.orientation).toBeLessThanOrEqual(8);
    }
  });
});

suite('decodeLinear', () => {
  const first = samples[0]!;

  it('returns a buffer that matches its header and honours maxEdge', async () => {
    for (const path of samples) {
      const info = await readRawInfo(path);
      const { header, data } = await decodeLinear(path, { maxEdge: 1024, sampleType: 'f32' });
      expect(header.sampleType).toBe('f32');
      expect(Math.max(header.width, header.height)).toBe(1024);
      expect(header.sourceWidth).toBe(info.width);
      expect(header.sourceHeight).toBe(info.height);
      expect(header.width / header.height).toBeCloseTo(info.width / info.height, 2);
      expect(data.length, path).toBe(header.width * header.height * 4 * 4);
    }
  });

  it(
    'defaults to half floats and full size, and never upscales',
    async () => {
      const info = await readRawInfo(first);
      const full = await decodeLinear(first);
      expect(full.header.sampleType).toBe('f16');
      expect([full.header.width, full.header.height]).toEqual([info.width, info.height]);
      expect(full.data.length).toBe(info.width * info.height * 4 * 2);
      const capped = await decodeLinear(first, { maxEdge: 100_000, sampleType: 'f16' });
      expect([capped.header.width, capped.header.height]).toEqual([info.width, info.height]);
    },
    slow,
  );

  it('has plausible colour metadata', async () => {
    for (const path of samples) {
      const { header } = await decodeLinear(path, { maxEdge: 256 });
      const { r, g, b } = header.asShotMultipliers;
      expect(g).toBe(1);
      expect(r).toBeGreaterThan(1);
      expect(b).toBeGreaterThan(1);
      expect(header.cameraToSrgb).toHaveLength(9);
      expect(header.xyzToCamera).toHaveLength(9);
      for (let row = 0; row < 3; row++) {
        const sum = header.cameraToSrgb.slice(row * 3, row * 3 + 3).reduce((a, v) => a + v, 0);
        expect(sum, `row ${row} of cameraToSrgb`).toBeCloseTo(1, 1);
      }
      expect(header.xyzToCamera.every((v) => Number.isFinite(v) && Math.abs(v) < 5)).toBe(true);
    }
  });

  it(
    'is linear light with white level 1.0 and alpha 1',
    async () => {
      const { header, data } = await decodeLinear(first, { maxEdge: 512, sampleType: 'f32' });
      const samples32 = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
      let max = 0;
      for (let i = 0; i < samples32.length; i += 4) {
        for (let c = 0; c < 3; c++) max = Math.max(max, samples32[i + c]!);
        expect(samples32[i + 3]).toBe(1);
      }
      expect(max).toBeLessThanOrEqual(1 + 1e-4);
      expect(max).toBeGreaterThan(0.3);

      // A scene's mean in linear light is low; gamma-encoded data would be well
      // above 0.4 for a typical exposure.
      const [r, g, b] = channelMeans(data);
      const mean = (r + g + b) / 3;
      expect(mean).toBeGreaterThan(0.002);
      expect(mean).toBeLessThan(0.4);

      // Linear data is resolution independent: a different downscale of the same
      // frame (a different decode path inside LibRaw) has the same channel means.
      const other = await decodeLinear(first, {
        maxEdge: Math.floor(Math.max(header.sourceWidth, header.sourceHeight) / 2) + 8,
        sampleType: 'f32',
      });
      const otherMeans = channelMeans(other.data);
      [r, g, b].forEach((value, c) => expect(otherMeans[c]! / value).toBeCloseTo(1, 1));
    },
    slow,
  );

  it('f16 and f32 agree', async () => {
    const f32 = await decodeLinear(first, { maxEdge: 256, sampleType: 'f32' });
    const f16 = await decodeLinear(first, { maxEdge: 256, sampleType: 'f16' });
    const a = new Float32Array(f32.data.buffer, f32.data.byteOffset, f32.data.length / 4);
    const b = new Uint16Array(f16.data.buffer, f16.data.byteOffset, f16.data.length / 2);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i += 97) {
      expect(Math.abs(halfToNumber(b[i]!) - a[i]!)).toBeLessThan(2e-3);
    }
  });

  it('rejects invalid options', async () => {
    await expect(decodeLinear(first, { maxEdge: 0 })).rejects.toThrow(/maxEdge/);
    await expect(
      // @ts-expect-error deliberately wrong sample type
      decodeLinear(first, { sampleType: 'f64' }),
    ).rejects.toThrow(/sampleType/);
    await expect(decodeLinear('/no/such/photo.NEF')).rejects.toThrow(/photo\.NEF/);
  });

  it(
    'does not block the JS thread',
    async () => {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      try {
        await decodeLinear(first);
      } finally {
        clearInterval(timer);
      }
      expect(ticks).toBeGreaterThan(3);
    },
    slow,
  );

  it(
    'logs decode timings',
    async () => {
      for (const [label, maxEdge] of [
        ['full size', undefined],
        ['2048px', 2048],
      ] as const) {
        const started = performance.now();
        const { header } = await decodeLinear(first, maxEdge === undefined ? {} : { maxEdge });
        const ms = Math.round(performance.now() - started);
        console.log(
          `bench: ${basename(first)} ${label} ${header.width}x${header.height}: ${ms} ms`,
        );
      }
    },
    slow,
  );
});
