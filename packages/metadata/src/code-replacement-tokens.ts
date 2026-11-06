import type { ReplacedRange } from '@ee/contracts';
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

export interface CodeReplacementSetOptions {
  /** PM's configurable delimiter; one character. Defaults to `=` (PM 6+). */
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
    const delimiter = options.delimiter ?? '=';
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
  /** Every token that was replaced, in the coordinates of the input and of `text`. */
  edits: ReplacedRange[];
}

export interface ExpandCodeReplacementsOptions {
  /**
   * Expand variables inside a code token before lookup, for PM's documented
   * `={monthname}=` pattern (the variable is evaluated, then the code is looked
   * up). The original token is still used for reporting.
   */
  resolveToken?: (token: string) => string | undefined;
}

export interface SelectedReplacement {
  replacement: string;
  /** The code as typed, including any `#N` selector. */
  token: string;
}

/**
 * The replacement for one token (the text between two delimiters): the code itself, or
 * `code#N` for the N-th column. Case sensitive; the default replacement is not used here.
 */
export function selectReplacement(
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
 * Expand `=code=` / `=code#N=` tokens (delimiter configurable).
 *
 * PM semantics implemented here (see the code replacement article linked in
 * `parseCodeReplacementFile`): the field selector `#N` picks a column
 * (`#1` is the default), unknown codes are left verbatim (unless a default
 * replacement is configured), and an empty pair (`==`) is not evaluated.
 * PM does not document an escape syntax; we deliberately do not invent one, so
 * a delimiter inside ordinary text (e.g. a Windows path) stays untouched and
 * is reported only when it happens to look like a code.
 */
export function expandCodeReplacements(
  text: string,
  set: CodeReplacementSet,
  options: ExpandCodeReplacementsOptions = {},
): ExpandCodeReplacementsResult {
  const delimiter = set.delimiter;
  const unknownCodes: string[] = [];
  const edits: ReplacedRange[] = [];
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
    const newFrom = output.length;
    if (selected !== undefined) {
      output += selected.replacement;
    } else if (set.defaultReplacement !== undefined) {
      output += set.defaultReplacement;
      unknownCodes.push(token);
    } else {
      output += text.slice(next, close + 1);
      unknownCodes.push(token);
      index = close + 1;
      continue;
    }
    edits.push({ from: next, to: close + 1, newFrom, newTo: output.length });
    index = close + 1;
  }

  return { text: output, unknownCodes, edits };
}

/** What typing the closing delimiter of a known code replaces: `[start, end)` becomes `replacement`. */
export interface InstantReplacement {
  start: number;
  end: number;
  replacement: string;
}

/**
 * The code that the delimiter just before `caret` closes, when `set` has a replacement for it.
 *
 * The opening delimiter is the nearest one before the closing one, so a closing delimiter that
 * found no match may open the next token: `=x=t1=` still finds `=t1=`. (The blur and Ctrl+Space
 * expansion pairs delimiters from the left and takes the closing one of an unknown token for
 * its own, so it leaves `t1=` there; that stays as it is.) A token is what
 * {@link expandCodeReplacements} reads: the text between two delimiters, not empty, looked up
 * by {@link selectReplacement}. Nothing is expanded inside the replacement, and a text that does
 * not end a known token (`a=b`, `=x=`, `==`) gives `undefined`.
 */
export function instantReplacement(
  text: string,
  caret: number,
  set: CodeReplacementSet,
): InstantReplacement | undefined {
  const delimiter = set.delimiter;
  if (caret < 3 || text.slice(caret - 1, caret) !== delimiter) return undefined;
  const open = text.lastIndexOf(delimiter, caret - 2);
  if (open === -1) return undefined;
  const token = text.slice(open + 1, caret - 1);
  if (token === '') return undefined;
  const selected = selectReplacement(set, token);
  if (selected === undefined) return undefined;
  return { start: open, end: caret, replacement: selected.replacement };
}

/**
 * Where a caret goes when the text around it was expanded. A caret inside a replaced stretch, or
 * right after it, goes to the end of its replacement; a caret before it, or in text that was not
 * touched, keeps its place in that text. `edits` are in input order and do not overlap.
 */
export function mapCaret(position: number, edits: readonly ReplacedRange[]): number {
  let shift = 0;
  for (const edit of edits) {
    if (position <= edit.from) break;
    if (position <= edit.to) return edit.newTo;
    shift = edit.newTo - edit.to;
  }
  return position + shift;
}

/** {@link mapCaret} through each expansion pass in turn. */
export function mapCaretThrough(
  position: number,
  passes: readonly (readonly ReplacedRange[])[],
): number {
  return passes.reduce((current, edits) => mapCaret(current, edits), position);
}
