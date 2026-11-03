import type { IptcFields } from '@ee/contracts';

export type MetadataFieldName = keyof IptcFields;

export interface MetadataFieldSpec {
  name: MetadataFieldName;
  label: string;
  placeholder?: string;
  multiline?: boolean;
}

/** The Metadata panel's field groups, shared with the Copy Metadata dialog. */
export const METADATA_SECTIONS: { title: string; fields: MetadataFieldSpec[] }[] = [
  {
    title: 'Caption',
    fields: [
      { name: 'headline', label: 'Headline' },
      {
        name: 'caption',
        label: 'Caption',
        multiline: true,
        placeholder: '=code= and {variables} are expanded on blur',
      },
      { name: 'keywords', label: 'Keywords' },
      { name: 'objectName', label: 'Object name' },
    ],
  },
  {
    title: 'Credits',
    fields: [
      { name: 'byline', label: 'Byline' },
      { name: 'bylineTitle', label: 'Byline title' },
      { name: 'credit', label: 'Credit' },
      { name: 'source', label: 'Source' },
      { name: 'copyright', label: 'Copyright' },
      { name: 'captionWriter', label: 'Caption writer' },
    ],
  },
  {
    title: 'Location',
    fields: [
      { name: 'city', label: 'City' },
      { name: 'state', label: 'State / province' },
      { name: 'country', label: 'Country' },
      { name: 'countryCode', label: 'Country code' },
      { name: 'location', label: 'Location' },
    ],
  },
  {
    title: 'Event / job',
    fields: [
      { name: 'event', label: 'Event' },
      { name: 'jobId', label: 'Job id' },
      { name: 'instructions', label: 'Instructions' },
      { name: 'dateCreated', label: 'Date created' },
    ],
  },
];

/** Fields in panel order; the dialog's All/None and copy use the same order. */
export const METADATA_FIELD_NAMES: MetadataFieldName[] = METADATA_SECTIONS.flatMap((section) =>
  section.fields.map((field) => field.name),
);

export const metadataValue = (value: IptcFields[MetadataFieldName] | undefined): string =>
  Array.isArray(value) ? value.join(', ') : (value ?? '');

/**
 * Copy the chosen fields from a photo's metadata. Checked empty fields become
 * an explicit `''` (or `[]` for keywords) so a paste clears them on the target.
 */
export function copyMetadataFields(
  fields: IptcFields,
  names: readonly MetadataFieldName[],
): Partial<IptcFields> {
  const copied: Partial<IptcFields> = {};
  for (const name of names) {
    if (name === 'keywords') {
      copied.keywords = [...(fields.keywords ?? [])];
      continue;
    }
    const value = fields[name];
    (copied as Record<string, string>)[name] = typeof value === 'string' ? value : '';
  }
  return copied;
}
