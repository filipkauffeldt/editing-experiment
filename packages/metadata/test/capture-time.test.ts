import { copyFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  formatCaptureDateTime,
  parseCaptureDateTime,
  shiftCaptureDateTime,
  shiftCaptureTimeValue,
} from '../src/capture-time-value';
import { readCaptureTime, shiftCaptureTime } from '../src/capture-time';
import { ExifToolService } from '../src/exiftool';
import { readIptc } from '../src/iptc';
import { sidecarPathFor } from '../src/paths';
import { toIsoDate } from '../src/values';
import {
  cleanupTempDirs,
  copyFixture,
  fixtureAvailable,
  makeJpeg,
  makeTempDir,
  sampleNefPath,
  sha256File,
} from './helpers';

describe('capture time values', () => {
  it('moves the wall clock across midnight and the end of a month', () => {
    expect(shiftCaptureTimeValue('2026-01-31T23:59:59', 2)).toBe('2026-02-01T00:00:01');
    expect(shiftCaptureTimeValue('2026-12-31T23:59:59.470+01:00', 2)).toBe(
      '2027-01-01T00:00:01.470+01:00',
    );
    expect(shiftCaptureTimeValue('2026-03-01T00:00:01', -2)).toBe('2026-02-28T23:59:59');
  });

  it('keeps the fraction and zone exactly as they were written', () => {
    const parts = parseCaptureDateTime('2026-10-03T18:13:16.310+02:00');
    expect(parts).toBeDefined();
    const shifted = shiftCaptureDateTime(parts!, 133);
    expect(formatCaptureDateTime(shifted)).toBe('2026-10-03T18:15:29.310+02:00');
  });

  it('treats a date without a clock time as no capture time', () => {
    expect(parseCaptureDateTime('2026-10-03')).toBeUndefined();
    expect(shiftCaptureTimeValue('2026-10-03', 60)).toBeUndefined();
  });
});

describe('capture time on disk', () => {
  let service: ExifToolService;

  beforeAll(() => {
    service = new ExifToolService();
  });
  afterAll(() => service.close());
  afterEach(cleanupTempDirs);

  /** The repo's CC0 fixture, or the owner's sample NEF when it was pointed at. */
  async function rawCopy(dir: string): Promise<string | undefined> {
    if (fixtureAvailable('z30_14bit.NEF')) return copyFixture('z30_14bit.NEF', dir);
    const sample = await sampleNefPath();
    if (sample === undefined) return undefined;
    const copy = join(dir, 'sample.NEF');
    await copyFile(sample, copy);
    return copy;
  }

  it('writes a shifted time into the raw sidecar and never touches the raw bytes', async () => {
    const dir = await makeTempDir();
    const raw = await rawCopy(dir);
    if (raw === undefined) return;
    const beforeHash = await sha256File(raw);
    const originalTags = await service.read(raw);
    const before = await readCaptureTime(raw, service);
    expect(before).toBeDefined();

    const shift = await shiftCaptureTime(raw, 133, { service });

    expect(shift).toBeDefined();
    expect(shift!.before).toBe(before);
    expect(shift!.after).toBe(shiftCaptureTimeValue(before!, 133));
    expect(await sha256File(raw)).toBe(beforeHash);
    expect(toIsoDate((await service.read(raw))['ExifIFD:DateTimeOriginal'])).toBe(
      toIsoDate(originalTags['ExifIFD:DateTimeOriginal']),
    );

    const sidecar = await service.read(sidecarPathFor(raw));
    expect(toIsoDate(sidecar['XMP-exif:DateTimeOriginal'])).toBe(shift!.after);
    expect(toIsoDate(sidecar['XMP-xmp:CreateDate'])).toBe(shift!.after);
    expect(toIsoDate(sidecar['XMP-photoshop:DateCreated'])).toBe(shift!.dateCreated);
    expect(await readCaptureTime(raw, service)).toBe(shift!.after);
  });

  it('lets an existing sidecar time win over the raw EXIF and shifts from it', async () => {
    const dir = await makeTempDir();
    const raw = await rawCopy(dir);
    if (raw === undefined) return;
    await service.write(sidecarPathFor(raw), {
      'XMP-exif:DateTimeOriginal': '2026-10-03T20:00:00',
      'XMP-xmp:CreateDate': '2026-10-03T20:00:00',
      'XMP-photoshop:DateCreated': '2026-10-03T20:00:00',
    });
    const rawTime = toIsoDate((await service.read(raw))['ExifIFD:DateTimeOriginal']);
    expect(rawTime).toBeDefined();
    expect(rawTime).not.toBe('2026-10-03T20:00:00');
    expect(await readCaptureTime(raw, service)).toBe('2026-10-03T20:00:00');

    const shift = await shiftCaptureTime(raw, -60, { service });

    expect(shift).toMatchObject({ before: '2026-10-03T20:00:00', after: '2026-10-03T19:59:00' });
    expect(toIsoDate((await service.read(raw))['ExifIFD:DateTimeOriginal'])).toBe(rawTime);
  });

  it('moves a raw twice from the sidecar time it wrote each time', async () => {
    const dir = await makeTempDir();
    const raw = await rawCopy(dir);
    if (raw === undefined) return;
    const beforeHash = await sha256File(raw);
    const before = await readCaptureTime(raw, service);
    expect(before).toBeDefined();

    const first = await shiftCaptureTime(raw, 120, { service });
    const second = await shiftCaptureTime(raw, 120, { service });

    expect(first!.after).toBe(shiftCaptureTimeValue(before!, 120));
    expect(second!.before).toBe(first!.after);
    expect(second!.after).toBe(shiftCaptureTimeValue(before!, 240));
    expect(await readCaptureTime(raw, service)).toBe(second!.after);
    expect(await sha256File(raw)).toBe(beforeHash);
  });

  it('moves embedded EXIF, XMP and IPTC dates across a month end and puts the file time back', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'shift.jpg');
    await makeJpeg(jpeg);
    await service.write(jpeg, {
      'EXIF:DateTimeOriginal': '2026:01:31 23:59:59',
      'EXIF:CreateDate': '2026:01:31 23:59:59',
      'EXIF:SubSecTimeOriginal': '47',
      'EXIF:SubSecTimeDigitized': '47',
      'EXIF:OffsetTimeOriginal': '+01:00',
      'EXIF:OffsetTimeDigitized': '+01:00',
      'XMP-exif:DateTimeOriginal': '2026-01-31T23:59:59.470+01:00',
      'XMP-xmp:CreateDate': '2026-01-31T23:59:59.470+01:00',
      'XMP-photoshop:DateCreated': '2026-01-31T23:59:59.470+01:00',
      'IPTC:DateCreated': '20260131',
      'IPTC:TimeCreated': '23:59:59+01:00',
    });
    const old = new Date('2001-01-01T00:00:00Z');
    await utimes(jpeg, new Date(), old);

    const shift = await shiftCaptureTime(jpeg, 2, { service });

    expect(shift).toEqual({
      before: '2026-01-31T23:59:59',
      after: '2026-02-01T00:00:01',
      dateCreated: '2026-02-01T00:00:01.470+01:00',
    });
    const tags = await service.read(jpeg);
    expect(toIsoDate(tags['ExifIFD:DateTimeOriginal'])).toBe('2026-02-01T00:00:01');
    expect(toIsoDate(tags['ExifIFD:CreateDate'])).toBe('2026-02-01T00:00:01');
    expect(toIsoDate(tags['XMP-exif:DateTimeOriginal'])).toBe('2026-02-01T00:00:01.470+01:00');
    expect(toIsoDate(tags['XMP-xmp:CreateDate'])).toBe('2026-02-01T00:00:01.470+01:00');
    expect(toIsoDate(tags['XMP-photoshop:DateCreated'])).toBe('2026-02-01T00:00:01.470+01:00');
    expect(toIsoDate(tags['IPTC:DateCreated'])).toBe('2026-02-01');
    expect(String(tags['IPTC:TimeCreated'])).toBe('00:00:01+01:00');
    expect(String(tags['ExifIFD:SubSecTimeOriginal'])).toBe('47');
    expect(String(tags['ExifIFD:SubSecTimeDigitized'])).toBe('47');
    expect(tags['ExifIFD:OffsetTimeOriginal']).toBe('+01:00');
    expect(tags['ExifIFD:OffsetTimeDigitized']).toBe('+01:00');
    expect((await readIptc(jpeg, service)).dateCreated).toBe('2026-02-01T00:00:01.470+01:00');
    expect((await stat(jpeg)).mtimeMs).toBe(old.getTime());
  });

  it('takes a shift back to the original values exactly', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'round-trip.jpg');
    await makeJpeg(jpeg);
    await service.write(jpeg, {
      'EXIF:DateTimeOriginal': '2026:10:03 18:13:16',
      'EXIF:CreateDate': '2026:10:03 18:13:16',
      'EXIF:SubSecTimeOriginal': '07',
      'EXIF:OffsetTimeOriginal': '+02:00',
      'XMP-exif:DateTimeOriginal': '2026-10-03T18:13:16.070+02:00',
      'XMP-xmp:CreateDate': '2026-10-03T18:13:16+02:00',
      'XMP-photoshop:DateCreated': '2026-10-03T18:13:16+02:00',
      'IPTC:DateCreated': '20261003',
      'IPTC:TimeCreated': '18:13:16+02:00',
    });
    const dateTags = (tags: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(tags).filter(([key]) =>
          /^(ExifIFD|XMP-[a-z]+|IPTC):(DateTimeOriginal|CreateDate|DateCreated|TimeCreated|SubSec\w+|OffsetTime\w+)$/.test(
            key,
          ),
        ),
      );
    const before = dateTags(await service.read(jpeg));

    await shiftCaptureTime(jpeg, 97, { service });
    await shiftCaptureTime(jpeg, -97, { service });

    expect(dateTags(await service.read(jpeg))).toEqual(before);
  });

  it('leaves a photo with no capture time alone', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'no-time.jpg');
    await makeJpeg(jpeg);
    const old = new Date('2001-01-01T00:00:00Z');
    await utimes(jpeg, new Date(), old);

    expect(await readCaptureTime(jpeg, service)).toBeUndefined();
    expect(await shiftCaptureTime(jpeg, 60, { service })).toBeUndefined();

    const tags = await service.read(jpeg);
    expect(tags['ExifIFD:DateTimeOriginal']).toBeUndefined();
    expect(tags['XMP-exif:DateTimeOriginal']).toBeUndefined();
    expect(tags['XMP-photoshop:DateCreated']).toBeUndefined();
    expect((await stat(jpeg)).mtimeMs).toBe(old.getTime());
  });
});
