import type { SourceId } from '@ee/contracts';
import { splitName } from './naming';

/** Values available to rename and destination-subfolder templates. */
export interface TemplateContext {
  sourceId: SourceId;
  sourceName: string;
  /** Absolute local path, or path on the remote server. */
  sourcePath: string;
  fileName: string;
  /** File name without its extension. */
  filenamebase: string;
  /** Extension including the dot, in its original case. */
  extension: string;
  /** 1-based position in this source's file order. */
  seq: number;
  /** Capture time when known, otherwise the file's modification time. */
  date: Date;
  now: Date;
}

export type ExpandTemplate = (template: string, context: TemplateContext) => string;

export interface TemplateContextInput {
  sourceId: SourceId;
  sourceName: string;
  sourcePath: string;
  fileName: string;
  seq: number;
  mtimeMs: number;
  now: Date;
  capturedAt?: Date;
}

export function createTemplateContext(input: TemplateContextInput): TemplateContext {
  const { base, extension } = splitName(input.fileName);
  const mtime = new Date(input.mtimeMs);
  return {
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    sourcePath: input.sourcePath,
    fileName: input.fileName,
    filenamebase: base,
    extension,
    seq: input.seq,
    date: input.capturedAt ?? (Number.isNaN(mtime.getTime()) ? input.now : mtime),
    now: input.now,
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatDate(date: Date, pattern: string): string {
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1, 2),
    DD: pad(date.getDate(), 2),
    HH: pad(date.getHours(), 2),
    mm: pad(date.getMinutes(), 2),
    ss: pad(date.getSeconds(), 2),
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => values[token] ?? token);
}

/**
 * Minimal built-in expander. The metadata package replaces this with the full
 * Photo Mechanic variable set; these tokens are enough for local tests.
 */
export const defaultExpandTemplate: ExpandTemplate = (template, context) =>
  template.replace(/\{([^{}]+)\}/g, (match, token: string) => {
    const [name = '', argument] = token.split(':', 2);
    switch (name) {
      case 'filenamebase':
        return context.filenamebase;
      case 'fileName':
        return context.fileName;
      case 'ext':
        return context.extension.replace(/^\./, '');
      case 'seq': {
        const width = argument ? Number(argument) : 0;
        if (!Number.isInteger(width) || width < 0) {
          return match;
        }
        return pad(context.seq, width);
      }
      case 'date':
        return formatDate(context.date, argument || 'YYYY-MM-DD');
      default:
        return match;
    }
  });
