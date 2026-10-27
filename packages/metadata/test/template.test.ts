import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { IptcFields } from '@ee/contracts';
import { ExifToolService } from '../src/exiftool';
import { readIptc, writeIptc } from '../src/iptc';
import { ensureXmpFile } from '../src/paths';
import { applyTemplate, diffFromTemplate, readTemplate } from '../src/template';
import { cleanupTempDirs, makeJpeg, makeTempDir } from './helpers';

const templateFields: IptcFields = {
  headline: 'Template headline',
  caption: 'Template caption åäö',
  city: 'Stockholm',
  country: 'Sweden',
  countryCode: 'SE',
  keywords: ['template', 'keywords'],
  byline: 'Template Photographer',
};

describe('Photo Mechanic metadata templates', () => {
  let service: ExifToolService;

  beforeAll(() => {
    service = new ExifToolService();
  });

  afterAll(async () => {
    await service.close();
  });

  afterEach(cleanupTempDirs);

  async function makeTemplate(dir: string): Promise<string> {
    const path = join(dir, 'PM_Metadata.XMP');
    await ensureXmpFile(path);
    await writeIptc(path, templateFields, { service });
    return path;
  }

  it('reads a PM .XMP template (only fields it sets)', async () => {
    const dir = await makeTempDir();
    const template = await makeTemplate(dir);

    expect(await readTemplate(template, service)).toEqual(templateFields);
  });

  it('applies a template in replace mode, leaving fields it does not set alone', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await writeIptc(jpeg, { caption: 'Old caption', instructions: 'Keep me' }, { service });

    const template = await makeTemplate(dir);
    const applied = await applyTemplate(jpeg, template, 'replace', { service });

    expect(applied).toEqual(templateFields);
    expect(await readIptc(jpeg, service)).toEqual({
      ...templateFields,
      instructions: 'Keep me',
    });
  });

  it('applies a template in fillEmpty mode', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await writeIptc(jpeg, { caption: 'Old caption' }, { service });

    const template = await makeTemplate(dir);
    const applied = await applyTemplate(jpeg, template, 'fillEmpty', { service });

    expect(applied).not.toHaveProperty('caption');
    expect(await readIptc(jpeg, service)).toEqual({
      ...templateFields,
      caption: 'Old caption',
    });
  });

  it('reports the fields that differ from a template', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await writeIptc(jpeg, { caption: 'Different caption', city: 'Stockholm' }, { service });

    const current = await readIptc(jpeg, service);
    expect(diffFromTemplate(current, templateFields)).toEqual([
      'headline',
      'caption',
      'keywords',
      'byline',
      'country',
      'countryCode',
    ]);

    const template = await makeTemplate(dir);
    await applyTemplate(jpeg, template, 'replace', { service });
    expect(diffFromTemplate(await readIptc(jpeg, service), templateFields)).toEqual([]);
  });
});
