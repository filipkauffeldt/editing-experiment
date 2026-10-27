import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { basename, join } from 'node:path';
import { copyFile } from 'node:fs/promises';
import type { IptcFields } from '@ee/contracts';
import { ExifToolService } from '../src/exiftool';
import type { MetadataError } from '../src/errors';
import { readIptc, writeIptc } from '../src/iptc';
import { fileExists, sidecarPathFor } from '../src/paths';
import {
  cleanupTempDirs,
  copyFixture,
  fixtureAvailable,
  makeJpeg,
  makeTempDir,
  sampleNefPath,
  sha256File,
} from './helpers';

const fields: IptcFields = {
  headline: 'Night game åäö 😀',
  caption: 'Caption with åäö and emoji 😀',
  keywords: ['sports', 'fotboll', 'åäö'],
  byline: 'Ada Lovelace',
  bylineTitle: 'Staff Photographer',
  credit: 'Example News',
  source: 'Example Agency',
  copyright: '© 2024 Ada Lovelace',
  city: 'Göteborg',
  state: 'Västra Götaland',
  country: 'Sweden',
  countryCode: 'SE',
  location: 'Gamla Ullevi',
  event: 'Allsvenskan',
  objectName: 'AIK vs IFK',
  jobId: 'JOB-42',
  instructions: 'Embargo until 22:00',
  captionWriter: 'Grace Hopper',
  dateCreated: '2024-05-06T19:08:09+02:00',
};

describe('IPTC read/write', () => {
  let service: ExifToolService;

  beforeAll(() => {
    service = new ExifToolService();
  });

  afterAll(async () => {
    await service.close();
  });

  afterEach(cleanupTempDirs);

  it('keeps IIM and XMP in sync with UTF-8 IIM in JPEGs', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await writeIptc(jpeg, fields, { service });

    const tags = await service.read(jpeg);
    expect(tags['IPTC:CodedCharacterSet']).toBe('UTF8');
    expect(tags['IPTC:Caption-Abstract']).toBe(fields.caption);
    expect(tags['XMP-dc:Description']).toBe(fields.caption);
    expect(tags['IPTC:Headline']).toBe(fields.headline);
    expect(tags['XMP-photoshop:Headline']).toBe(fields.headline);
    expect(tags['IPTC:Keywords']).toEqual(fields.keywords);
    expect(tags['XMP-dc:Subject']).toEqual(fields.keywords);
    expect(tags['IPTC:Country-PrimaryLocationCode']).toBe('SE');
    expect(tags['XMP-iptcCore:CountryCode']).toBe('SE');
    expect(tags['XMP-iptcExt:Event']).toBe(fields.event);
    expect(tags['File:CurrentIPTCDigest']).toEqual(expect.any(String));

    expect(await readIptc(jpeg, service)).toEqual(fields);
  });

  it('leaves unlisted fields alone and deletes empty ones', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'partial.jpg');
    await makeJpeg(jpeg);

    await writeIptc(jpeg, { headline: 'First', city: 'Malmö' }, { service });
    await writeIptc(jpeg, { headline: 'Second' }, { service });
    expect(await readIptc(jpeg, service)).toEqual({ headline: 'Second', city: 'Malmö' });

    await writeIptc(jpeg, { city: '' }, { service });
    expect(await readIptc(jpeg, service)).toEqual({ headline: 'Second' });
  });

  it('rejects a date that is not ISO 8601', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'date.jpg');
    await makeJpeg(jpeg);

    await expect(writeIptc(jpeg, { dateCreated: '06/05/2024' }, { service })).rejects.toMatchObject(
      { code: 'INVALID_XMP' } satisfies Partial<MetadataError>,
    );
  });

  it('uses a sidecar for any non-embedded file and never writes the original', async () => {
    const dir = await makeTempDir();
    // Extension decides the metadata strategy; content is irrelevant here.
    const raw = join(dir, 'shot.NEF');
    await makeJpeg(raw);
    const before = await sha256File(raw);

    expect(await readIptc(raw, service)).toEqual({});
    await writeIptc(raw, {}, { service });
    expect(await fileExists(sidecarPathFor(raw))).toBe(false);

    await writeIptc(raw, { headline: 'Sidecar only' }, { service });
    expect(await fileExists(sidecarPathFor(raw))).toBe(true);
    await writeIptc(raw, { city: 'Lund' }, { service });

    expect(await readIptc(raw, service)).toEqual({ headline: 'Sidecar only', city: 'Lund' });
    expect(await sha256File(raw)).toBe(before);
  });

  describe.skipIf(!fixtureAvailable('z30_14bit.NEF'))('raw sidecars', () => {
    it('creates a sidecar, merges writes, and never changes the NEF', async () => {
      const dir = await makeTempDir();
      const nef = await copyFixture('z30_14bit.NEF', dir);
      const before = await sha256File(nef);

      expect(await readIptc(nef, service)).toEqual({});

      await writeIptc(nef, { headline: 'Raw headline', keywords: ['one'] }, { service });
      expect(await readIptc(nef, service)).toEqual({
        headline: 'Raw headline',
        keywords: ['one'],
      });

      await writeIptc(nef, { city: 'Uppsala', caption: 'Raw åäö 😀' }, { service });
      expect(await readIptc(nef, service)).toEqual({
        headline: 'Raw headline',
        keywords: ['one'],
        city: 'Uppsala',
        caption: 'Raw åäö 😀',
      });

      expect(await fileExists(sidecarPathFor(nef))).toBe(true);
      expect(await sha256File(nef)).toBe(before);
    });

    it('does not mistake embedded crd: camera defaults for user edits', async () => {
      const dir = await makeTempDir();
      const nef = await copyFixture('z30_14bit.NEF', dir);
      const before = await sha256File(nef);

      const rawTags = await service.read(nef);
      expect(rawTags['XMP-crd:Exposure2012']).toBeDefined();

      expect(await readIptc(nef, service)).toEqual({});
      expect(await sha256File(nef)).toBe(before);
    });
  });

  it('handles the user’s Nikon Z 6 files from EE_SAMPLE_NEF_DIR', async () => {
    const sample = await sampleNefPath();
    if (sample === undefined) return; // skipped cleanly when unset

    const dir = await makeTempDir();
    const nef = join(dir, basename(sample));
    await copyFile(sample, nef);
    const before = await sha256File(nef);

    await writeIptc(nef, { caption: 'Z 6 sample 😀', event: 'Sample event' }, { service });
    expect(await readIptc(nef, service)).toEqual({
      caption: 'Z 6 sample 😀',
      event: 'Sample event',
    });
    expect(await sha256File(nef)).toBe(before);
  });
});
