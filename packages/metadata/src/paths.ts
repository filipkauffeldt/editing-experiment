import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join, parse } from 'node:path';

/**
 * Camera raw extensions whose metadata belongs in a sidecar. DNG is included:
 * it is a raw format and the app must never rewrite the original.
 */
const RAW_EXTENSIONS = new Set([
  '.3fr',
  '.arw',
  '.cr2',
  '.cr3',
  '.crw',
  '.dng',
  '.erf',
  '.fff',
  '.iiq',
  '.kdc',
  '.mef',
  '.mos',
  '.mrw',
  '.nef',
  '.nrw',
  '.orf',
  '.pef',
  '.raf',
  '.raw',
  '.rw2',
  '.rwl',
  '.sr2',
  '.srf',
  '.srw',
  '.x3f',
]);

/** Formats where IPTC IIM and XMP are embedded in the file itself. */
const EMBEDDED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.tif', '.tiff']);

export function isRawPath(path: string): boolean {
  return RAW_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isEmbeddedMetadataPath(path: string): boolean {
  return EMBEDDED_EXTENSIONS.has(extname(path).toLowerCase());
}

/** An XMP file itself (sidecar or Photo Mechanic template). */
export function isXmpPath(path: string): boolean {
  return extname(path).toLowerCase() === '.xmp';
}

/** `photo.NEF` → `photo.xmp` (same directory, Lightroom/PM compatible naming). */
export function sidecarPathFor(path: string): string {
  const parsed = parse(path);
  return join(parsed.dir, `${parsed.name}.xmp`);
}

/**
 * The file metadata is actually read from and written to for a photo path:
 * the sidecar for raws, the file itself for JPEG/TIFF, and a sidecar for
 * anything else (never risk writing an unknown original).
 */
export function metadataTargetFor(path: string): string {
  return isEmbeddedMetadataPath(path) || isXmpPath(path) ? path : sidecarPathFor(path);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const MINIMAL_XMP = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="editing-experiment">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;

/** Create a minimal, valid XMP packet at exactly `path` (no extension rewriting). */
export async function ensureXmpFile(path: string): Promise<void> {
  if (await fileExists(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, MINIMAL_XMP, 'utf8');
}

/**
 * Create an empty XMP sidecar if it does not exist. ExifTool cannot create a
 * file from nothing, so the packet has to exist before the first write.
 */
export async function ensureSidecar(path: string): Promise<string> {
  const sidecar = sidecarPathFor(path);
  await ensureXmpFile(sidecar);
  return sidecar;
}

/**
 * Ensure the file IPTC/develop data will be written to exists. XMP files are
 * used as-is; raws use a sidecar; other formats are embedded.
 */
export async function ensureMetadataTarget(path: string): Promise<string> {
  if (isEmbeddedMetadataPath(path) || isXmpPath(path)) {
    await ensureXmpFile(path);
    return path;
  }
  return ensureSidecar(path);
}
