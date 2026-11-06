import type { CodeReplacementFilesResult } from '@ee/contracts';
import {
  CodeReplacementSet,
  instantReplacement,
  parseCodeReplacementFile,
  type CodeReplacementTable,
  type InstantReplacement,
} from '@ee/metadata/code-replacement-tokens';

/**
 * The code replacement tables as the caption field needs them while typing: parsed once and kept
 * here, so a code is looked up in memory and never waits for the jobs process or ExifTool.
 *
 * {@link refresh} asks for the files again; nothing is parsed when no file's modified time (or
 * the list) changed. A file that cannot be read is reported once and its codes are left out; the
 * other files still work, and typing is never interrupted.
 */
export class CodeReplacementTables {
  #set: CodeReplacementSet | undefined;
  #signature = '';
  #chain: Promise<void> = Promise.resolve();
  /** The last error shown for each file, so one that stays broken is not shown on every focus. */
  readonly #reported = new Map<string, string>();

  constructor(
    private readonly load: () => Promise<CodeReplacementFilesResult>,
    private readonly report: (message: string) => void,
  ) {}

  /** Reads the files again. Calls queue, so the newest answer is the one that is kept. */
  refresh(): Promise<void> {
    this.#chain = this.#chain.then(() => this.#refresh());
    return this.#chain;
  }

  /** What typing a delimiter at `caret` in `text` replaces, or `undefined` (also while loading). */
  replacementFor(text: string, caret: number): InstantReplacement | undefined {
    return this.#set === undefined ? undefined : instantReplacement(text, caret, this.#set);
  }

  async #refresh(): Promise<void> {
    let result: CodeReplacementFilesResult;
    try {
      result = await this.load();
    } catch (cause) {
      this.#reportOnce('', `Could not read the code replacement files: ${messageOf(cause)}`);
      return;
    }
    this.#reported.delete('');
    const signature = result.files
      .map((file) =>
        'error' in file ? `${file.path}!${file.error}` : `${file.path}:${file.mtimeMs}`,
      )
      .join('\n');
    if (signature === this.#signature) return;
    this.#signature = signature;

    const tables: CodeReplacementTable[] = [];
    for (const file of result.files) {
      if ('error' in file) {
        this.#reportOnce(file.path, file.error);
      } else {
        this.#reported.delete(file.path);
        tables.push(parseCodeReplacementFile(file.text));
      }
    }
    this.#set = tables.length === 0 ? undefined : new CodeReplacementSet(tables);
  }

  #reportOnce(key: string, message: string): void {
    if (this.#reported.get(key) === message) return;
    this.#reported.set(key, message);
    this.report(message);
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
