import { readFile } from 'node:fs/promises';
import { MetadataError } from './errors';

/** One parsed code replacement file. */
export class CodeReplacementTable {
  readonly #entries: ReadonlyMap<string, readonly string[]>;

  constructor(entries: ReadonlyMap<string, readonly string[]>) {
    this.#entries = entries;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Replacements for `code` (first is the default), or `undefined`. */
  lookup(code: string): readonly string[] | undefined {
    return this.#entries.get(code);
  }

  /** All codes, for diagnostics. */
  get codes(): readonly string[] {
    return [...this.#entries.keys()];
  }
}

/**
 * Parse a Photo Mechanic code replacement file.
 *
 * Format (https://docs.camerabits.com/support/solutions/articles/48000223660):
 * UTF-8, one code per line in column 1, tab-separated replacements after it.
 * Codes are case sensitive. Lines whose first column is `//`, and columns from
 * the first cell starting with `//` onwards, are comments.
 */
export function parseCodeReplacementFile(text: string): CodeReplacementTable {
  const entries = new Map<string, readonly string[]>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (line.trimStart().startsWith('//')) continue;
    const columns = line.split('\t');
    const code = columns[0];
    if (code === undefined || code === '') continue;

    const replacements: string[] = [];
    for (const column of columns.slice(1)) {
      if (column.startsWith('//')) break;
      replacements.push(column);
    }
    if (replacements.length === 0) continue;
    // Later lines for the same code win, matching PM's in-file reload.
    entries.set(code, replacements);
  }
  return new CodeReplacementTable(entries);
}

export async function loadCodeReplacementFile(path: string): Promise<CodeReplacementTable> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new MetadataError('INVALID_CODE_REPLACEMENTS', `Cannot read ${path}`, { cause });
  }
  return parseCodeReplacementFile(text);
}

export interface CodeReplacementSetOptions {
  /** PM's configurable delimiter; one character. Defaults to `\`. */
  delimiter?: string;
  /**
   * Optional PM "default replacement" used for unknown codes. When absent,
   * unknown codes are left verbatim (PM's behaviour without a default).
   */
  defaultReplacement?: string;
}

/**
 * A merged set of code replacement files. Files are applied in order: when the
 * same code appears in more than one file, the later file wins, matching PM's
 * "most recently loaded replacement will take preference".
 */
export class CodeReplacementSet {
  readonly delimiter: string;
  readonly defaultReplacement: string | undefined;
  readonly #entries: ReadonlyMap<string, readonly string[]>;

  constructor(tables: readonly CodeReplacementTable[], options: CodeReplacementSetOptions = {}) {
    const delimiter = options.delimiter ?? '\\';
    if (delimiter.length !== 1) {
      throw new MetadataError('INVALID_CODE_REPLACEMENTS', 'Delimiter must be one character');
    }
    this.delimiter = delimiter;
    this.defaultReplacement = options.defaultReplacement;
    const merged = new Map<string, readonly string[]>();
    for (const table of tables) {
      for (const code of table.codes) {
        const replacements = table.lookup(code);
        if (replacements !== undefined) merged.set(code, replacements);
      }
    }
    this.#entries = merged;
  }

  lookup(code: string): readonly string[] | undefined {
    return this.#entries.get(code);
  }

  get size(): number {
    return this.#entries.size;
  }
}

export interface ExpandCodeReplacementsResult {
  text: string;
  /** Code tokens that had no replacement, left verbatim. */
  unknownCodes: string[];
}

export interface ExpandCodeReplacementsOptions {
  /**
   * Expand variables inside a code token before lookup, for PM's documented
   * `={monthname}=` pattern (the variable is evaluated, then the code is looked
   * up). The original token is still used for reporting.
   */
  resolveToken?: (token: string) => string | undefined;
}

interface SelectedReplacement {
  replacement: string;
  /** The code as typed, including any `#N` selector. */
  token: string;
}

function selectReplacement(
  set: CodeReplacementSet,
  token: string,
): SelectedReplacement | undefined {
  const exact = set.lookup(token);
  if (exact !== undefined) {
    const replacement = exact[0];
    return replacement === undefined ? undefined : { replacement, token };
  }
  const match = /^(.*)#(\d+)$/.exec(token);
  if (match === null) return undefined;
  const code = match[1] as string;
  const column = Number(match[2]);
  if (!Number.isInteger(column) || column < 1) return undefined;
  const replacements = set.lookup(code);
  const replacement = replacements?.[column - 1];
  return replacement === undefined ? undefined : { replacement, token };
}

/**
 * Expand `\code\` / `\code#N\` tokens.
 *
 * PM semantics implemented here (see the code replacement article linked in
 * `parseCodeReplacementFile`): the field selector `#N` picks a column
 * (`#1` is the default), unknown codes are left verbatim (unless a default
 * replacement is configured), and an empty pair (`\\`) is not evaluated.
 * PM does not document an escape syntax; we deliberately do not invent one, so
 * a delimiter inside ordinary text (e.g. a Windows path) stays untouched and
 * is reported when it happens to look like a code.
 */
export function expandCodeReplacements(
  text: string,
  set: CodeReplacementSet,
  options: ExpandCodeReplacementsOptions = {},
): ExpandCodeReplacementsResult {
  const delimiter = set.delimiter;
  const unknownCodes: string[] = [];
  let output = '';
  let index = 0;

  while (index < text.length) {
    const next = text.indexOf(delimiter, index);
    if (next === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, next);
    const close = text.indexOf(delimiter, next + 1);
    if (close === -1) {
      output += text.slice(next);
      break;
    }
    const token = text.slice(next + 1, close);
    if (token === '') {
      output += delimiter + delimiter;
      index = close + 1;
      continue;
    }
    let selected = selectReplacement(set, token);
    if (selected === undefined && options.resolveToken !== undefined) {
      const resolvedToken = options.resolveToken(token);
      if (resolvedToken !== undefined && resolvedToken !== token) {
        selected = selectReplacement(set, resolvedToken);
      }
    }
    if (selected !== undefined) {
      output += selected.replacement;
    } else if (set.defaultReplacement !== undefined) {
      output += set.defaultReplacement;
      unknownCodes.push(token);
    } else {
      output += text.slice(next, close + 1);
      unknownCodes.push(token);
    }
    index = close + 1;
  }

  return { text: output, unknownCodes };
}

/** Load files in order and merge them into one set. */
export async function loadCodeReplacements(
  paths: readonly string[],
  options: CodeReplacementSetOptions = {},
): Promise<CodeReplacementSet> {
  const tables: CodeReplacementTable[] = [];
  for (const path of paths) tables.push(await loadCodeReplacementFile(path));
  return new CodeReplacementSet(tables, options);
}
