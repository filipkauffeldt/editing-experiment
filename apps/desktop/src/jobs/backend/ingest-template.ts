import { expandVariables, type CaptionContext } from '@ee/metadata';
import type { ExpandTemplate, TemplateContext } from '@ee/ingest';

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

function formatDate(date: Date, pattern: string): string {
  const parts: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => parts[token] ?? token);
}

/**
 * Rename and subfolder templates: the Photo Mechanic `{variables}` from
 * `@ee/metadata` (`{date}`, `{seq:4}`, `{filenamebase}`, `{camera}`, ...) plus the
 * ingest-only ones the contract documents: `{sourceName}`, `{sourceId}`, `{ext}`
 * and `{date:YYYY-MM-DD}` with an explicit pattern.
 *
 * Capture time is the file's modification time when the ingest engine has no
 * better date; for cards and cameras that is the time of shooting.
 */
export const expandIngestTemplate: ExpandTemplate = (template, context: TemplateContext) => {
  const ingestOnly = template
    .replace(/\{date:([^{}]+)\}/g, (_match, pattern: string) => formatDate(context.date, pattern))
    .replace(/\{sourceName\}/gi, context.sourceName)
    .replace(/\{sourceId\}/gi, context.sourceId)
    .replace(/\{ext\}/gi, context.extension.replace(/^\./, ''));
  const caption: CaptionContext = {
    filePath: context.sourcePath,
    fileName: context.fileName,
    fileNameBase: context.filenamebase,
    captureTime: context.date,
    now: context.now,
    sequence: context.seq,
  };
  return expandVariables(ingestOnly, caption).text;
};
