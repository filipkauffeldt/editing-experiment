import type { ToneCurvePoint } from '@ee/contracts';
import {
  PresetParseError,
  settingsToPreset,
  type ParsedPreset,
  type ParseOptions,
  type RawSetting,
} from './settings';

/**
 * Parser for the Lua-table text of `.lrtemplate` develop presets (Lightroom
 * Classic before the XMP preset format): `s = { title = "...", value = {
 * settings = { Exposure2012 = 0.5, ToneCurvePV2012 = { 0, 0, 255, 255 } } } }`.
 * Only the data subset of Lua is handled: tables, strings, numbers, booleans.
 */

type LuaValue = string | number | boolean | null | LuaTable;
interface LuaTable {
  named: Map<string, LuaValue>;
  items: LuaValue[];
}

const TOKEN =
  /\s+|--\[\[[\s\S]*?\]\]|--[^\n]*|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([{}[\]=,;])/gy;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m)
      throw new PresetParseError(
        `Unexpected character ${JSON.stringify(text[start])} at offset ${start}`,
      );
    const [whole, dq, sq, num, ident, punct] = m;
    if (dq !== undefined) tokens.push(JSON.stringify(dq.replace(/\\(.)/g, '$1')));
    else if (sq !== undefined) tokens.push(JSON.stringify(sq.replace(/\\(.)/g, '$1')));
    else if (num !== undefined) tokens.push(num);
    else if (ident !== undefined) tokens.push(ident);
    else if (punct !== undefined) tokens.push(punct);
    else if (!whole.trim() && whole.length === 0)
      throw new PresetParseError('Tokenizer made no progress');
  }
  return tokens;
}

class Reader {
  private pos = 0;
  constructor(private readonly tokens: string[]) {}

  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const t = this.tokens[this.pos++];
    if (t === undefined) throw new PresetParseError('Unexpected end of preset');
    return t;
  }
  expect(token: string): void {
    const t = this.next();
    if (t !== token) throw new PresetParseError(`Expected ${token} but found ${t}`);
  }

  value(): LuaValue {
    const t = this.next();
    if (t === '{') return this.table();
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'nil') return null;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    throw new PresetParseError(`Unexpected token ${t}`);
  }

  private table(): LuaTable {
    const table: LuaTable = { named: new Map(), items: [] };
    for (;;) {
      const t = this.peek();
      if (t === undefined) throw new PresetParseError('Unterminated table');
      if (t === '}') {
        this.next();
        return table;
      }
      if (t === ',' || t === ';') {
        this.next();
        continue;
      }
      if (t === '[') {
        this.next();
        const key = this.value();
        this.expect(']');
        this.expect('=');
        table.named.set(String(key), this.value());
      } else if (/^[A-Za-z_]/.test(t) && this.tokens[this.pos + 1] === '=') {
        this.next();
        this.next();
        table.named.set(t, this.value());
      } else {
        table.items.push(this.value());
      }
    }
  }
}

const isTable = (v: LuaValue | undefined): v is LuaTable => typeof v === 'object' && v !== null;

function toRaw(value: LuaValue): RawSetting {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'scalar', value: String(value) };
  }
  return { kind: 'other' };
}

/** Parses a `.lrtemplate` develop preset. */
export function parsePresetLrtemplate(text: string, options: ParseOptions = {}): ParsedPreset {
  const reader = new Reader(tokenize(text));
  if (reader.peek() === undefined) throw new PresetParseError('Empty preset');
  // `s = { ... }` or a bare `{ ... }`.
  if (reader.peek() !== '{') {
    reader.next();
    reader.expect('=');
  }
  const root = reader.value();
  if (!isTable(root)) throw new PresetParseError('Preset does not contain a table');

  const value = root.named.get('value');
  const settingsTable = isTable(value) ? value.named.get('settings') : undefined;
  if (!isTable(settingsTable))
    throw new PresetParseError('No develop settings found in this .lrtemplate');

  const settings = new Map<string, RawSetting>();
  for (const [key, v] of settingsTable.named) {
    if (key.startsWith('ToneCurve') && isTable(v)) {
      // Flat list x0, y0, x1, y1, ...
      const nums = v.items.filter((i): i is number => typeof i === 'number');
      const points: ToneCurvePoint[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i] ?? 0, nums[i + 1] ?? 0]);
      settings.set(key, { kind: 'curve', points });
    } else {
      settings.set(key, toRaw(v));
    }
  }

  const title = root.named.get('title');
  const internal = root.named.get('internalName');
  const id = root.named.get('id');
  return settingsToPreset(
    settings,
    {
      name: typeof title === 'string' ? title : typeof internal === 'string' ? internal : undefined,
      uuid: typeof id === 'string' ? id : undefined,
    },
    options,
  );
}
