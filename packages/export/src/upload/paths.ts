import path from 'node:path';
import { ExportError } from '../errors';

/** Rejects file names that would escape the output directory. */
export function assertSafeFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('\0') ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new ExportError('invalid_file_name', `Invalid file name: ${JSON.stringify(fileName)}`);
  }
}

/**
 * Resolves a folder destination path below its configured base. Both `/` and
 * `\` in the template are treated as separators so templates stay portable.
 */
export function resolveFolderDestinationPath(basePath: string, remotePath: string): string {
  const relative = remotePath.replace(/^[/\\]+/, '');
  if (relative.length === 0) {
    throw new ExportError('invalid_path', 'Destination path template expanded to an empty path');
  }
  const base = path.resolve(basePath);
  const resolved = path.resolve(base, relative.replace(/[\\/]+/g, path.sep));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new ExportError(
      'invalid_path',
      `Destination path escapes its base directory: ${remotePath}`,
    );
  }
  if (resolved === base) {
    throw new ExportError(
      'invalid_path',
      'Destination path template expanded to the base directory',
    );
  }
  return resolved;
}

/** Normalizes a remote (FTP/SFTP) path to forward slashes and rejects traversal. */
export function normalizeRemotePath(remotePath: string): string {
  const slashed = remotePath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(slashed);
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '/' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.endsWith('/') ||
    normalized.includes('\0')
  ) {
    throw new ExportError('invalid_path', `Invalid remote path: ${JSON.stringify(remotePath)}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new ExportError('invalid_path', `Remote path escapes its directory: ${remotePath}`);
  }
  return normalized;
}

/** Name used while a transfer is in flight; renamed to the final name when complete. */
export function tempRemotePath(finalPath: string): string {
  return `${finalPath}.part`;
}
