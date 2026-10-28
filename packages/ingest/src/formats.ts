import { extname } from 'node:path';

/** Extensions of raw formats that get an XMP sidecar. Lower case, no dot. */
export const RAW_EXTENSIONS: ReadonlySet<string> = new Set([
  '3fr',
  'arw',
  'cr2',
  'cr3',
  'dcr',
  'dng',
  'erf',
  'fff',
  'iiq',
  'k25',
  'kdc',
  'mef',
  'mos',
  'nef',
  'nrw',
  'orf',
  'pef',
  'raf',
  'raw',
  'rw2',
  'rwl',
  'sr2',
  'srf',
  'srw',
  'x3f',
]);

/** Extensions ingest treats as photographs. Lower case, no dot. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...RAW_EXTENSIONS,
  'avif',
  'heic',
  'heif',
  'jpe',
  'jpeg',
  'jpg',
  'png',
  'tif',
  'tiff',
  'webp',
]);

/** Lower-case extension without the leading dot, or `''` when there is none. */
export function extensionOf(fileName: string): string {
  return extname(fileName).slice(1).toLowerCase();
}

export function isImageFileName(fileName: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(fileName));
}

export function isRawFileName(fileName: string): boolean {
  return RAW_EXTENSIONS.has(extensionOf(fileName));
}
