import path from 'node:path';
import type { CredentialSecret } from '@ee/contracts';
import type { PhotoId } from '@ee/contracts';

/**
 * Values available to `{variable}` placeholders in remote path templates.
 * Hooks may use the whole context and add their own variables.
 */
export interface PathTemplateContext {
  /** File name including extension, e.g. `2026-10-27_FCB_001.jpg`. */
  fileName: string;
  /** File name without extension. */
  filenamebase: string;
  /** Capture/export date as `YYYY-MM-DD`. */
  date: string;
  photoId: PhotoId;
  /** Set when the template is expanded per destination. */
  destinationId?: string;
  destinationName?: string;
}

/** Expands a `{variable}` path template. Unknown variables are left verbatim. */
export type ExpandPathTemplate = (template: string, context: PathTemplateContext) => string;

/**
 * Writes IPTC/XMP into an encoded JPEG. Injected by the metadata workstream so
 * this package does not depend on ExifTool. Must not add thumbnails/previews.
 */
export type WriteMetadataHook = (jpegPath: string, photoId: PhotoId) => Promise<void>;

/** Reads a credential from the main process's `safeStorage` store. */
export type GetSecretHook = (credentialRef: string) => Promise<CredentialSecret>;

/** Hooks supplied by the host process (jobs/utility process). */
export interface ExportHooks {
  /** Required to embed metadata; skipped when `preset.metadata === 'none'`. */
  writeMetadata?: WriteMetadataHook;
  /** Replaces the built-in template expander. */
  expandPathTemplate?: ExpandPathTemplate;
  /** Required for FTP/SFTP destinations. */
  getSecret?: GetSecretHook;
}

const TEMPLATE_VARIABLE = /\{([a-zA-Z][\w:.-]*)\}/g;

/** Minimal built-in expander used by tests and as a fallback. */
export const defaultExpandPathTemplate: ExpandPathTemplate = (template, context) =>
  template.replace(TEMPLATE_VARIABLE, (match, name: string) => {
    const value = (context as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : match;
  });

/** Builds the variable context for one exported file. */
export function createPathTemplateContext(
  fileName: string,
  photoId: PhotoId,
  now: Date = new Date(),
): PathTemplateContext {
  const year = now.getFullYear().toString().padStart(4, '0');
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  return {
    fileName,
    filenamebase: path.parse(fileName).name,
    date: `${year}-${month}-${day}`,
    photoId,
  };
}

export function resolveExpandPathTemplate(hooks: ExportHooks | undefined): ExpandPathTemplate {
  return hooks?.expandPathTemplate ?? defaultExpandPathTemplate;
}
