import type { IptcFields, PhotoId } from '@ee/contracts';
import { METADATA_SECTIONS } from './metadata-fields';

type FieldValue = IptcFields[keyof IptcFields];

/** One photo's fields before and after a change, restricted to the fields the change touched. */
export interface MetadataEntry {
  photoId: PhotoId;
  before: Partial<IptcFields>;
  after: Partial<IptcFields>;
}

/** A field with no value, written to clear it (the backend removes the tag for these). */
const emptyValue = (field: keyof IptcFields): FieldValue => (field === 'keywords' ? [] : '');

/** A copy that later edits of the live fields can not reach, with a missing value made empty. */
export function snapshotField(field: keyof IptcFields, value: FieldValue): FieldValue {
  if (value === undefined) return emptyValue(field);
  return Array.isArray(value) ? [...value] : value;
}

export function sameField(field: keyof IptcFields, left: FieldValue, right: FieldValue): boolean {
  return JSON.stringify(snapshotField(field, left)) === JSON.stringify(snapshotField(field, right));
}

/** The values of `names` in `fields`, missing ones as empty, so an undo clears them again. */
export function pickFields(
  fields: IptcFields,
  names: readonly (keyof IptcFields)[],
): Partial<IptcFields> {
  const picked: Record<string, FieldValue> = {};
  for (const name of names) picked[name] = snapshotField(name, fields[name]);
  return picked as Partial<IptcFields>;
}

/** A copy of a change's values. */
export function snapshotFields(fields: Partial<IptcFields>): Partial<IptcFields> {
  const copy: Record<string, FieldValue> = {};
  for (const [name, value] of Object.entries(fields)) {
    copy[name] = snapshotField(name as keyof IptcFields, value as FieldValue);
  }
  return copy as Partial<IptcFields>;
}

const LABELS = new Map(
  METADATA_SECTIONS.flatMap((section) =>
    section.fields.map((field) => [field.name, field.label.toLowerCase()] as const),
  ),
);

/** How a change to these fields is called in the undo toast: "caption", "caption and keywords". */
export function fieldsWhat(names: readonly (keyof IptcFields)[]): string {
  const labels = names.map((name) => LABELS.get(name) ?? name);
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return 'metadata';
}
