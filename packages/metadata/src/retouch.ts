import type { RetouchVersion } from '@ee/contracts';
import { MetadataError } from './errors';
import { getExifToolService, type ExifToolService, type ExifToolTagValue } from './exiftool';
import {
  ensureMetadataTarget,
  ensureSidecar,
  fileExists,
  isRawPath,
  isXmpPath,
  metadataTargetFor,
  sidecarPathFor,
} from './paths';
import { asString } from './values';

/** `ee:` XMP property holding retouch versions as JSON (PoC storage). */
export const RETOUCH_VERSIONS_TAG = 'XMP-ee:RetouchVersions';

const TARGET_TAGS = { RetouchVersions: RETOUCH_VERSIONS_TAG } as const;

async function targetForWrite(path: string, hasData: boolean): Promise<string | undefined> {
  if (isRawPath(path)) {
    const sidecar = sidecarPathFor(path);
    if (!hasData && !(await fileExists(sidecar))) return undefined;
    return ensureSidecar(path);
  }
  if (isXmpPath(path)) return ensureMetadataTarget(path);
  return metadataTargetFor(path);
}

/** Read retouch versions from the sidecar (`ee:`) or embedded XMP (JPEG/TIFF). */
export async function readRetouchVersions(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<RetouchVersion[]> {
  const target = isRawPath(path) ? sidecarPathFor(path) : metadataTargetFor(path);
  if (!(await fileExists(target))) {
    if (isRawPath(path)) return [];
    throw new MetadataError('EXIFTOOL', `Metadata file not found: ${target}`);
  }
  const tags = await service.read(target);
  const raw = tags[TARGET_TAGS.RetouchVersions];
  if (raw === undefined || raw === null) return [];
  const text = asString(raw);
  if (text === undefined || text.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new MetadataError('INVALID_XMP', 'ee:RetouchVersions is not valid JSON', { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new MetadataError('INVALID_XMP', 'ee:RetouchVersions must be a JSON array');
  }
  const versions = parsed.filter(isRetouchVersion);
  if (versions.length !== parsed.length) {
    throw new MetadataError('INVALID_XMP', 'ee:RetouchVersions contains invalid versions');
  }
  return versions;
}

function isRetouchVersion(value: unknown): value is RetouchVersion {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RetouchVersion>;
  return (
    typeof candidate.id === 'string' && candidate.kind === 'retouch' && Array.isArray(candidate.ops)
  );
}

/** Write the whole retouch version list; an empty list deletes the property. */
export async function writeRetouchVersions(
  path: string,
  versions: readonly RetouchVersion[],
  options: { service?: ExifToolService } = {},
): Promise<void> {
  const service = options.service ?? getExifToolService();
  const target = await targetForWrite(path, versions.length > 0);
  if (target === undefined) return;
  const tag: ExifToolTagValue = versions.length === 0 ? null : JSON.stringify(versions);
  await service.write(target, { [TARGET_TAGS.RetouchVersions]: tag });
}
