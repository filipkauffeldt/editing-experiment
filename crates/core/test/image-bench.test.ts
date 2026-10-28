import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJpeg, encodeJpeg, extractPreview, makePreviews, resizeRgba } from '../src/index';

// Benchmark on the embedded previews of the user's own NEFs (read only, never
// committed). Skipped without EE_SAMPLE_NEF_DIR.
const dir = process.env['EE_SAMPLE_NEF_DIR'];
const files =
  dir !== undefined && existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.nef'))
        .sort()
        .map((name) => join(dir, name))
    : [];
const suite = files.length > 0 ? describe : describe.skip;
if (files.length === 0) console.warn('skipping image benchmark: set EE_SAMPLE_NEF_DIR');

const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[values.length >> 1]!;

suite('image pipeline benchmark', () => {
  it('decode + two resizes + two encodes of a raw preview stays well under 300 ms', async () => {
    const rows: string[] = [];
    const totals: number[] = [];
    const combined: number[] = [];
    // First pass warms the threadpool and page cache; only the second is reported.
    for (const pass of [0, 1]) {
      for (const file of files) {
        const { jpeg, width, height } = await extractPreview(file);

        let t = process.hrtime.bigint();
        const image = await decodeJpeg(jpeg);
        const decode = ms(t);
        t = process.hrtime.bigint();
        const preview = await resizeRgba(image.rgba, image.width, image.height, { maxEdge: 2048 });
        const thumb = await resizeRgba(image.rgba, image.width, image.height, { maxEdge: 256 });
        const resize = ms(t);
        t = process.hrtime.bigint();
        const quality = { quality: 85, chroma: '420', iccSrgb: true } as const;
        await Promise.all([
          encodeJpeg(preview.rgba, preview.width, preview.height, quality),
          encodeJpeg(thumb.rgba, thumb.width, thumb.height, quality),
        ]);
        const encode = ms(t);
        totals.push(decode + resize + encode);

        t = process.hrtime.bigint();
        await makePreviews(jpeg, { thumbEdge: 256, previewEdge: 2048, quality: 85 });
        const convenience = ms(t);
        if (pass === 1) {
          combined.push(convenience);
          rows.push(
            `${file.split(/[\\/]/).pop()} ${width}x${height}: decode ${decode.toFixed(0)} ms, ` +
              `2 resizes ${resize.toFixed(0)} ms, 2 encodes ${encode.toFixed(0)} ms, ` +
              `makePreviews ${convenience.toFixed(0)} ms`,
          );
        }
      }
    }
    console.log(`image benchmark (sequential calls vs makePreviews):\n${rows.join('\n')}`);
    console.log(`makePreviews median: ${median(combined).toFixed(0)} ms`);
    expect(median(combined)).toBeLessThan(300);
  });
});
