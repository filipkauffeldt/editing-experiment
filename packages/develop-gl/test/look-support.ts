import type { ProfileTable } from '@ee/contracts';
import { compressBigTable } from '../src/profile/look';

/** Synthetic XMP looks for the tests (node only: the table encoding uses zlib). */

/** The bytes of a version 1 or 2 HSV big table, the way Adobe stores a look's table. */
export function bigTableBytes(table: ProfileTable, bounds?: [number, number]): Uint8Array {
  const count = table.data.length / 3;
  const version = bounds ? 2 : 1;
  const tail = version === 2 ? 20 : 4;
  const out = Buffer.alloc(20 + count * 12 + tail);
  out.writeUInt32LE(0, 0);
  out.writeUInt32LE(version, 4);
  out.writeUInt32LE(table.hueDivisions, 8);
  out.writeUInt32LE(table.satDivisions, 12);
  out.writeUInt32LE(table.valDivisions, 16);
  table.data.forEach((v, i) => out.writeFloatLE(v, 20 + i * 4));
  const end = 20 + count * 12;
  out.writeUInt32LE(table.srgbEncoding ? 1 : 0, end);
  if (bounds) {
    out.writeDoubleLE(bounds[0], end + 4);
    out.writeDoubleLE(bounds[1], end + 12);
  }
  return out;
}

export interface LookSpec {
  name?: string;
  uuid?: string;
  base?: string | null;
  table?: ProfileTable;
  bounds?: [number, number];
  supportsAmount?: boolean;
  /** `crs:ToneCurvePV2012` points on 0..255. */
  curve?: [number, number][];
  attributes?: Record<string, string>;
}

const TABLE_ID = '0123456789abcdef0123456789abcdef';

/** A look profile `.xmp`, in the shape Camera Raw writes (attributes on the description, curve as `rdf:Seq`). */
export function buildLookXmp(spec: LookSpec): string {
  const attrs: Record<string, string> = {
    'crs:PresetType': 'Look',
    'crs:UUID': spec.uuid ?? 'B952C231111CD8E0ECCF14B86BAA7077',
    'crs:SupportsAmount': spec.supportsAmount ? 'True' : 'False',
    'crs:Version': '14.3',
    'crs:ProcessVersion': '11.0',
    'crs:ConvertToGrayscale': 'False',
    ...(spec.base === null ? {} : { 'crs:CameraProfile': spec.base ?? 'Test Standard' }),
    ...spec.attributes,
  };
  if (spec.table) {
    attrs['crs:LookTable'] = TABLE_ID;
    attrs[`crs:Table_${TABLE_ID}`] = compressBigTable(bigTableBytes(spec.table, spec.bounds));
  }
  const attributeText = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const curve = spec.curve
    ? `<crs:ToneCurvePV2012><rdf:Seq>${spec.curve
        .map(([x, y]) => `<rdf:li>${x}, ${y}</rdf:li>`)
        .join('')}</rdf:Seq></crs:ToneCurvePV2012>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${attributeText}>
   <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">${spec.name ?? 'Test Color'}</rdf:li></rdf:Alt></crs:Name>
   <crs:Group><rdf:Alt><rdf:li xml:lang="x-default">Profiles</rdf:li></rdf:Alt></crs:Group>
   ${curve}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}
