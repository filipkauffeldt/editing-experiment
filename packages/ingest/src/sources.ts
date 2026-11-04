import { readdir, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { CardSource, FolderSource } from '@ee/contracts';
import { IngestError } from './errors';
import { isImageFileName, isRawFileName } from './formats';
import { isTemporaryName, naturalCompare, splitName } from './naming';
import type { SourceFile } from './types';

export interface ListImagesOptions {
  recursive?: boolean;
}

async function safeReadDirectory(
  path: string,
): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return [];
    }
    throw error;
  }
}

function toPosixFolder(folder: string): string {
  return sep === '/' ? folder : folder.split(sep).join('/');
}

async function walk(
  directory: string,
  relativeFolder: string,
  recursive: boolean,
  files: SourceFile[],
): Promise<void> {
  const entries = await safeReadDirectory(directory);
  const subdirectories = entries
    .filter((entry) => entry.isDirectory && !isTemporaryName(entry.name))
    .sort((a, b) => naturalCompare(a.name, b.name));
  const images = entries
    .filter((entry) => entry.isFile && isImageFileName(entry.name) && !isTemporaryName(entry.name))
    .sort((a, b) => naturalCompare(a.name, b.name));

  for (const entry of images) {
    const path = join(directory, entry.name);
    try {
      const info = await stat(path);
      files.push({
        path,
        name: entry.name,
        relativeFolder: toPosixFolder(relativeFolder),
        extension: splitName(entry.name).extension,
        size: info.size,
        mtimeMs: info.mtimeMs,
        mode: info.mode,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (!recursive) {
    return;
  }
  for (const entry of subdirectories) {
    const nextFolder = relativeFolder ? join(relativeFolder, entry.name) : entry.name;
    await walk(join(directory, entry.name), nextFolder, true, files);
  }
}

/**
 * Lists image files in natural order. Files are ordered by their folder
 * (relative to the root), then by name, so `100NCZ` comes before `101NCZ`.
 */
export async function listImageFiles(
  root: string,
  options: ListImagesOptions = {},
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  await walk(root, '', options.recursive ?? false, files);
  return files.sort(
    (a, b) => naturalCompare(a.relativeFolder, b.relativeFolder) || naturalCompare(a.name, b.name),
  );
}

/** Lists the files one local source will ingest, in copy order. */
export async function listSourceFiles(source: FolderSource | CardSource): Promise<SourceFile[]> {
  if (source.kind === 'folder') {
    try {
      const info = await stat(source.path);
      if (!info.isDirectory()) {
        throw new IngestError(`Folder source is not a directory: ${source.path}`, 'not-a-folder');
      }
    } catch (error) {
      if (error instanceof IngestError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new IngestError(`Folder source does not exist: ${source.path}`, 'not-a-folder');
      }
      throw error;
    }
    return listImageFiles(source.path, { recursive: source.recursive ?? false });
  }
  const dcim = join(source.mountPath, 'DCIM');
  // A card can be pulled between the last scan and the click on Ingest. Name the card in
  // the error so the run says which one is missing; the other sources keep going.
  const missing = (detail: string): IngestError =>
    new IngestError(
      `Card "${source.name}" is not available at ${source.mountPath}: ${detail}. Put it back and ingest again.`,
      'not-a-card',
    );
  try {
    const info = await stat(dcim);
    if (!info.isDirectory()) {
      throw missing('it has no DCIM folder');
    }
  } catch (error) {
    if (error instanceof IngestError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw missing('it was removed or has no DCIM folder');
    }
    throw missing(error instanceof Error ? error.message : String(error));
  }
  return listImageFiles(dcim, { recursive: true });
}

/**
 * Finds a sidecar next to a raw. Camera vendors are inconsistent about the
 * extension case, so match case-insensitively.
 */
export async function findSidecar(file: SourceFile): Promise<string | undefined> {
  if (!isRawFileName(file.name)) {
    return undefined;
  }
  const directory = dirname(file.path);
  const wanted = `${splitName(file.name).base}.xmp`.toLowerCase();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  const match = names.find((name) => name.toLowerCase() === wanted);
  return match ? join(directory, match) : undefined;
}
