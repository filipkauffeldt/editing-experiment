import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LogRedactor } from '../shared/log-redact';

export type LogLevel = 'warn' | 'error';
/** Which process a line came from. */
export type LogSource = 'main' | 'jobs' | 'renderer';

export interface LogFileOptions {
  dir: string;
  /** A file that would grow past this is rotated first. */
  maxBytes: number;
  /** Files kept, the current one included: `ee.log`, `ee.1.log`, … */
  maxFiles: number;
  now?: () => Date;
}

export const LOG_FILE_NAME = 'ee.log';
export const DEFAULT_LOG_LIMITS = { maxBytes: 2 * 1024 * 1024, maxFiles: 5 } as const;

/**
 * The app's log: one rotating text file under `userData/logs`, written only by the main process
 * (the jobs process and the renderer send their lines to it), so rotation never races.
 *
 * Writes are synchronous. The log is for warnings and errors, so the volume is small, and a line
 * written just before a crash must be on disk when the process dies. Every line is redacted first.
 */
export class RotatingLogFile {
  readonly redactor = new LogRedactor();
  private readonly now: () => Date;

  constructor(private readonly options: LogFileOptions) {
    this.now = options.now ?? (() => new Date());
    mkdirSync(options.dir, { recursive: true });
  }

  get dir(): string {
    return this.options.dir;
  }

  get file(): string {
    return join(this.options.dir, LOG_FILE_NAME);
  }

  write(source: LogSource, level: LogLevel, message: string): void {
    const text = this.redactor.redact(message).replace(/\r?\n/g, '\n    ');
    const line = `${this.now().toISOString()} ${level === 'error' ? 'ERROR' : 'WARN '} [${source}] ${text}\n`;
    try {
      this.rotateFor(Buffer.byteLength(line));
      appendFileSync(this.file, line);
    } catch {
      // A full disk or a folder that went away must not take the app down with it.
    }
  }

  private archived(index: number): string {
    return join(this.options.dir, `ee.${index}.log`);
  }

  private rotateFor(incoming: number): void {
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    // A single line longer than the limit still goes into an empty file.
    if (size === 0 || size + incoming <= this.options.maxBytes) return;
    const oldest = this.options.maxFiles - 1;
    if (oldest < 1) {
      rmSync(this.file, { force: true });
      return;
    }
    rmSync(this.archived(oldest), { force: true });
    for (let index = oldest - 1; index >= 1; index--) {
      try {
        renameSync(this.archived(index), this.archived(index + 1));
      } catch {
        // That generation does not exist yet.
      }
    }
    renameSync(this.file, this.archived(1));
  }
}
