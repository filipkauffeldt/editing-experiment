import type { ToneCurvePoint } from '@ee/contracts';
import { XMLParser } from 'fast-xml-parser';
import {
  PresetParseError,
  settingsToPreset,
  type ParsedPreset,
  type ParseOptions,
  type PresetMeta,
  type RawSetting,
} from './settings';

const CRS_NAMESPACE = 'http://ns.adobe.com/camera-raw-settings/1.0/';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Keep every value a string: "+0.50" and "5500" are interpreted by the preset code, with clamping.
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => name === 'rdf:li',
});

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null;

/** All `rdf:Description` nodes anywhere in the document (Lightroom writes one, other tools may write several). */
function findDescriptions(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const item of node) findDescriptions(item, out);
  } else if (isNode(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'rdf:Description') {
        for (const d of Array.isArray(value) ? value : [value]) if (isNode(d)) out.push(d);
      } else if (!key.startsWith('@_')) {
        findDescriptions(value, out);
      }
    }
  }
  return out;
}

/** The text of a node that may be a string or an element with attributes (`{ '#text': ... }`). */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isNode(value) && typeof value['#text'] === 'string') return value['#text'];
  return undefined;
}

/** `rdf:Seq` / `rdf:Bag` / `rdf:Alt` items of a property element. */
function listItems(value: unknown): unknown[] | undefined {
  if (!isNode(value)) return undefined;
  for (const container of ['rdf:Seq', 'rdf:Bag', 'rdf:Alt']) {
    const inner = value[container];
    if (isNode(inner) && Array.isArray(inner['rdf:li'])) return inner['rdf:li'] as unknown[];
  }
  return undefined;
}

/** Language alternative (`rdf:Alt`): the `x-default` entry, else the first. */
function altText(value: unknown): string | undefined {
  const items = listItems(value);
  if (!items) return textOf(value);
  const preferred = items.find((i) => isNode(i) && i['@_xml:lang'] === 'x-default') ?? items[0];
  return textOf(preferred);
}

function parseCurve(items: unknown[]): ToneCurvePoint[] {
  const points: ToneCurvePoint[] = [];
  for (const item of items) {
    const [x, y] = (textOf(item) ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y))
      points.push([x, y]);
  }
  return points;
}

/**
 * Parses a Lightroom / Camera Raw develop preset (`.xmp`): settings given as
 * `crs:` attributes of `rdf:Description` and as child elements, tone curves as
 * `rdf:Seq` lists of `"x, y"` items. Values are clamped to `SLIDER_SPECS`;
 * unsupported settings are reported, not applied.
 */
export function parsePresetXmp(xml: string, options: ParseOptions = {}): ParsedPreset {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (error) {
    throw new PresetParseError(
      `Not valid XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const descriptions = findDescriptions(doc);
  const settings = new Map<string, RawSetting>();
  const meta: PresetMeta = {};
  let sawCrs = false;

  for (const description of descriptions) {
    // The conventional prefix is `crs`, but honour whatever the file binds to the namespace.
    let prefix = 'crs';
    for (const [key, value] of Object.entries(description)) {
      if (key.startsWith('@_xmlns:') && value === CRS_NAMESPACE)
        prefix = key.slice('@_xmlns:'.length);
    }
    const tag = `${prefix}:`;

    for (const [key, value] of Object.entries(description)) {
      const attribute = key.startsWith('@_');
      const qualified = attribute ? key.slice(2) : key;
      if (!qualified.startsWith(tag)) continue;
      sawCrs = true;
      const name = qualified.slice(tag.length);

      if (name === 'UUID') meta.uuid = textOf(value);
      if (name === 'Name') meta.name = altText(value);

      if (
        typeof value === 'string' ||
        (!attribute && textOf(value) !== undefined && !listItems(value))
      ) {
        settings.set(name, { kind: 'scalar', value: textOf(value) ?? '' });
        continue;
      }
      const items = listItems(value);
      if (items && name.startsWith('ToneCurve'))
        settings.set(name, { kind: 'curve', points: parseCurve(items) });
      else settings.set(name, { kind: 'other' });
    }
  }

  if (!sawCrs)
    throw new PresetParseError('No crs: develop settings found; this is not a Lightroom preset');
  return settingsToPreset(settings, meta, options);
}
