import type { IptcFields } from '@ee/contracts';
import { IPTC_FIELD_NAMES } from '@ee/contracts';
import { getExifToolService, type ExifToolService } from './exiftool';
import { readIptc, readIptcFromXmpFile, writeIptc } from './iptc';

export type TemplateApplyMode = 'replace' | 'fillEmpty';

export interface ApplyTemplateOptions {
  service?: ExifToolService;
}

/**
 * Read a Photo Mechanic metadata template (".XMP template file" saved from the
 * Metadata (IPTC) Template dialog / former IPTC Stationery Pad).
 *
 * PM only writes the fields that have text in them ("Only the text you
 * currently have in each field is saved" — Camera Bits forum, 2020), so
 * absent keys here mean "the template does not set this field", not "delete".
 * https://camerabits.freshdesk.com/support/solutions/articles/48000207623
 */
export async function readTemplate(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<IptcFields> {
  return readIptcFromXmpFile(path, service);
}

/**
 * Apply a template to a photo.
 *
 * - `replace`: overwrite every field the template sets.
 * - `fillEmpty`: only set fields that are currently absent or empty.
 *
 * Fields the template does not mention are never touched.
 */
export async function applyTemplate(
  target: string,
  template: IptcFields | string,
  mode: TemplateApplyMode = 'replace',
  options: ApplyTemplateOptions = {},
): Promise<IptcFields> {
  const service = options.service ?? getExifToolService();
  const fields = typeof template === 'string' ? await readTemplate(template, service) : template;

  let toWrite: Partial<IptcFields>;
  if (mode === 'fillEmpty') {
    const current = await readIptc(target, service);
    toWrite = {};
    for (const name of IPTC_FIELD_NAMES) {
      const value = fields[name];
      if (value === undefined) continue;
      if (isEmpty(current[name])) {
        assign(toWrite, name, value);
      }
    }
  } else {
    toWrite = {};
    for (const name of IPTC_FIELD_NAMES) {
      const value = fields[name];
      if (value === undefined) continue;
      assign(toWrite, name, value);
    }
  }

  await writeIptc(target, toWrite, { service });
  return toWrite as IptcFields;
}

/**
 * Fields in `fields` that differ from the template. Used for the
 * "metadata differs from template" badge. Only fields the template sets are
 * compared; an absent/empty current value counts as different.
 */
export function diffFromTemplate(fields: IptcFields, template: IptcFields): (keyof IptcFields)[] {
  const different: (keyof IptcFields)[] = [];
  for (const name of IPTC_FIELD_NAMES) {
    const expected = template[name];
    if (expected === undefined) continue;
    if (!sameValue(fields[name], expected)) different.push(name);
  }
  return different;
}

function sameValue(
  actual: IptcFields[keyof IptcFields],
  expected: IptcFields[keyof IptcFields],
): boolean {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, i) => item === expected[i]);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) return false;
  return actual === expected;
}

function isEmpty(value: IptcFields[keyof IptcFields]): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value === '';
}

function assign(
  target: Partial<IptcFields>,
  name: keyof IptcFields,
  value: IptcFields[keyof IptcFields],
): void {
  if (Array.isArray(value)) {
    if (name === 'keywords') target.keywords = [...value];
    return;
  }
  if (typeof value === 'string' && name !== 'keywords') {
    (target as Record<string, string>)[name] = value;
  }
}
