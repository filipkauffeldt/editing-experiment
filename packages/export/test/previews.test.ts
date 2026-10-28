import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExifTool } from 'exiftool-vendored';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoEmbeddedPreviews,
  encodeJpeg,
  EmbeddedPreviewError,
  inspectJpegPreviews,
} from '../src/index';
import {
  insertExifThumbnail,
  insertPhotoshopThumbnail,
  insertXmpThumbnail,
  jfifThumbnailSegment,
  jfxxThumbnailSegment,
  malformedExifSegment,
  malformedPhotoshopSegment,
  mpfSegment,
  withSegment,
  xmpThumbnailUtf16Segment,
} from './helpers/embedded';
import { testImage } from './helpers/images';
import { testPreset } from './helpers/presets';

describe('embedded preview detection', () => {
  let dir: string;
  let exiftool: ExifTool;
  let cleanJpeg: Buffer;
  let thumbnailJpeg: Buffer;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-previews-'));
    exiftool = new ExifTool();
    cleanJpeg = (await encodeJpeg(testImage(96, 64), testPreset({ quality: 90, metadata: 'all' })))
      .data;
    thumbnailJpeg = (
      await encodeJpeg(testImage(24, 16), testPreset({ quality: 80, metadata: 'none' }))
    ).data;
  });

  afterAll(async () => {
    await exiftool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a clean encoded JPEG', async () => {
    expect(inspectJpegPreviews(cleanJpeg)).toEqual([]);
    const file = path.join(dir, 'clean.jpg');
    await writeFile(file, cleanJpeg);
    await expect(assertNoEmbeddedPreviews(file)).resolves.toBeUndefined();
  });

  it('passes EXIF without previews', async () => {
    const file = path.join(dir, 'artist.jpg');
    await writeFile(file, cleanJpeg);
    await exiftool.write(file, { Artist: 'Test Photographer', Copyright: 'Test' }, [
      '-overwrite_original',
    ]);
    await expect(assertNoEmbeddedPreviews(file)).resolves.toBeUndefined();
  });

  it('detects an EXIF IFD1 thumbnail', async () => {
    const dirty = insertExifThumbnail(cleanJpeg, thumbnailJpeg);
    const findings = inspectJpegPreviews(dirty);
    expect(findings.map((finding) => finding.kind)).toContain('exif-ifd1');
    expect(findings.map((finding) => finding.kind)).toContain('exif-thumbnail-tags');

    const file = path.join(dir, 'exif-thumb.jpg');
    await writeFile(file, dirty);
    const tags = await exiftool.read(file);
    expect(tags.ThumbnailImage).toBeDefined();
    await expect(assertNoEmbeddedPreviews(file)).rejects.toBeInstanceOf(EmbeddedPreviewError);
  });

  it('detects an XMP thumbnail', () => {
    const findings = inspectJpegPreviews(insertXmpThumbnail(cleanJpeg));
    expect(findings.map((finding) => finding.kind)).toContain('xmp-thumbnail');
  });

  it('detects a Photoshop IRB thumbnail', () => {
    const findings = inspectJpegPreviews(insertPhotoshopThumbnail(cleanJpeg));
    expect(findings.map((finding) => finding.kind)).toContain('photoshop-thumbnail');
  });

  it('rejects a JFIF APP0 thumbnail', () => {
    const segment = jfifThumbnailSegment();
    const findings = inspectJpegPreviews(withSegment(cleanJpeg, segment.marker, segment.payload));
    expect(findings.map((finding) => finding.kind)).toContain('jfif-thumbnail');
  });

  it('rejects a JFXX APP0 block with an embedded JPEG', () => {
    const segment = jfxxThumbnailSegment(thumbnailJpeg);
    const findings = inspectJpegPreviews(withSegment(cleanJpeg, segment.marker, segment.payload));
    expect(findings.map((finding) => finding.kind)).toContain('unexpected-app0');
  });

  it('rejects an MPF APP2 block', () => {
    const segment = mpfSegment();
    const findings = inspectJpegPreviews(withSegment(cleanJpeg, segment.marker, segment.payload));
    expect(findings.map((finding) => finding.kind)).toContain('unexpected-app2');
  });

  it('rejects bytes and a second JPEG after EOI', () => {
    const trailing = inspectJpegPreviews(Buffer.concat([cleanJpeg, Buffer.from([1, 2, 3])]));
    expect(trailing.map((finding) => finding.kind)).toContain('trailing-data');

    const appended = inspectJpegPreviews(Buffer.concat([cleanJpeg, thumbnailJpeg]));
    expect(appended.map((finding) => finding.kind)).toContain('second-soi');
    expect(appended.map((finding) => finding.kind)).toContain('trailing-data');
  });

  it('rejects UTF-16 XMP with a thumbnail', () => {
    const segment = xmpThumbnailUtf16Segment();
    const findings = inspectJpegPreviews(withSegment(cleanJpeg, segment.marker, segment.payload));
    expect(findings.map((finding) => finding.kind)).toContain('xmp-thumbnail');
  });

  it.each(['magic', 'ifd'] as const)('fails closed on malformed EXIF (%s)', (kind) => {
    const segment = malformedExifSegment(kind);
    const findings = inspectJpegPreviews(withSegment(cleanJpeg, segment.marker, segment.payload));
    expect(findings.map((finding) => finding.kind)).toContain('malformed-exif');
  });

  it.each(['signature', 'truncated'] as const)(
    'fails closed on malformed Photoshop IRB (%s)',
    (kind) => {
      const segment = malformedPhotoshopSegment(kind);
      const findings = inspectJpegPreviews(withSegment(cleanJpeg, segment.marker, segment.payload));
      expect(findings.map((finding) => finding.kind)).toContain('malformed-photoshop');
    },
  );

  it('reports the offending file and findings', async () => {
    const file = path.join(dir, 'dirty.jpg');
    await writeFile(file, insertPhotoshopThumbnail(cleanJpeg));
    const error = await assertNoEmbeddedPreviews(file).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(EmbeddedPreviewError);
    expect((error as EmbeddedPreviewError).findings.length).toBeGreaterThan(0);
    expect((error as EmbeddedPreviewError).message).toContain(file);
  });

  it('rejects non-JPEG input', () => {
    expect(() => inspectJpegPreviews(Buffer.from('not a jpeg'))).toThrowError(/SOI/);
  });
});
