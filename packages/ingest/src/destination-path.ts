// No Node imports: the Ingest view runs this to show where the first file will land, and
// ingest itself runs the same functions for every file (see ingest-file.ts).
import type { FileNamingMode, IngestDestination } from '@ee/contracts';
import { PathTraversalError } from './errors';
import { safeFileBase, safeSubfolderParts, splitName } from './path-names';
import type { ExpandTemplate, TemplateContext } from './template';

/** A destination's subfolder template expanded for one file, before it is checked. */
export function expandSubfolder(
  destination: IngestDestination,
  context: TemplateContext,
  expandTemplate: ExpandTemplate,
): string {
  return destination.subfolderTemplate
    ? expandTemplate(destination.subfolderTemplate, context)
    : '';
}

export interface FileNaming {
  fileNaming: FileNamingMode;
  renameTemplate: string;
}

/**
 * The base name (no extension) a file is first tried under, before a collision suffix. Keeping
 * the original base name still runs through the file-name guard: it is a real name, but must
 * never become a path or an empty name.
 */
export function plannedFileBase(
  naming: FileNaming,
  sourceFileName: string,
  context: TemplateContext,
  expandTemplate: ExpandTemplate,
): string {
  return naming.fileNaming === 'keep'
    ? safeFileBase(splitName(sourceFileName).base)
    : safeFileBase(expandTemplate(naming.renameTemplate, context));
}

/** The separator a path is written with: backslash for `E:\Photos`, a slash for `/Photos`. */
function displaySeparator(base: string): '\\' | '/' {
  return base.includes('\\') || /^[A-Za-z]:/.test(base) ? '\\' : '/';
}

/**
 * Joins folder and file names onto `base` for display, keeping the way `base` is written.
 * Ingest joins with the platform's `path.join`; this is for text that is only shown.
 */
export function joinDisplayPath(base: string, names: readonly string[]): string {
  const separator = displaySeparator(base);
  const root = base.replace(/[\\/]+$/, '');
  if (names.length === 0) return root === '' ? base : root;
  const joined = [root, ...names].join(separator);
  return separator === '\\' ? joined.replaceAll('/', '\\') : joined;
}

export interface IngestPathPreviewInput extends FileNaming {
  destination: IngestDestination;
  /** The file the preview is for; `fileName` is its real or example name. */
  context: TemplateContext;
  expandTemplate: ExpandTemplate;
}

export type IngestPathPreview =
  { ok: true; directory: string; fileName: string; path: string } | { ok: false; message: string };

/**
 * Where the first copy of a file lands, computed the way ingest computes it: the same template
 * expansion and the same name checks. A collision suffix is not predicted. A template that
 * ingest would refuse (a path in a rename template, a subfolder that leaves the destination)
 * returns the reason instead of a path.
 */
export function previewIngestPath(input: IngestPathPreviewInput): IngestPathPreview {
  const { destination, context, expandTemplate } = input;
  if (destination.path.trim() === '') {
    return { ok: false, message: 'Choose a destination folder.' };
  }
  try {
    const subfolder = safeSubfolderParts(expandSubfolder(destination, context, expandTemplate));
    const fileName = `${plannedFileBase(input, context.fileName, context, expandTemplate)}${context.extension}`;
    const directory = joinDisplayPath(destination.path, subfolder);
    return {
      ok: true,
      directory,
      fileName,
      path: joinDisplayPath(destination.path, [...subfolder, fileName]),
    };
  } catch (cause) {
    if (cause instanceof PathTraversalError) return { ok: false, message: cause.message };
    throw cause;
  }
}
