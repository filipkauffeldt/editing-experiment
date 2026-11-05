import type { IptcFields, Photo } from '@ee/contracts';

export const THUMB_SIZE_RANGE = { min: 96, max: 280, default: 160 } as const;

export interface LibraryState {
  /** Folder (directory of the local copy) shown in the grid; absent means every folder. */
  folder?: string;
  view: 'grid' | 'loupe';
  thumbSize: number;
}

export const initialLibrary = (): LibraryState => ({
  view: 'grid',
  thumbSize: THUMB_SIZE_RANGE.default,
});

/** Directory of a path, accepting either separator (the renderer has no `node:path`). */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? '' : cut === 0 ? path.slice(0, 1) : path.slice(0, cut);
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || path;
}

export interface LibraryFolder {
  path: string;
  name: string;
  count: number;
}

/**
 * The local folders that hold ingested copies, from the photos themselves. A photo's `path` is
 * always its copy in the ingest destination, so cards and remote servers can never appear here.
 */
export function libraryFolders(photos: readonly Photo[]): LibraryFolder[] {
  const counts = new Map<string, number>();
  for (const photo of photos) {
    const folder = folderOf(photo.path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts]
    .map(([path, count]) => ({ path, name: baseName(path), count }))
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
}

/** Whether the photo is in the folder the Library shows (every folder when none is picked). */
export function inLibraryFolder(photo: Photo, library: LibraryState): boolean {
  return library.folder === undefined || folderOf(photo.path) === library.folder;
}

/** What one IPTC field should become on every selected photo. */
export interface FieldEdit {
  field: keyof IptcFields;
  value: string | string[];
  mode: 'replace' | 'append';
}

const asText = (value: IptcFields[keyof IptcFields] | undefined): string =>
  Array.isArray(value) ? value.join(', ') : (value ?? '');

/**
 * Apply batch edits to one photo's fields and return only the changed fields. Append adds to
 * what is there (text after a space, keywords as a union); replace overwrites.
 */
export function mergeFieldEdits(
  current: IptcFields,
  edits: readonly FieldEdit[],
): Partial<IptcFields> {
  const patch: Record<string, unknown> = {};
  for (const edit of edits) {
    const existing = current[edit.field];
    if (edit.field === 'keywords') {
      const added = Array.isArray(edit.value) ? edit.value : [edit.value];
      const base = Array.isArray(existing) ? existing : [];
      patch.keywords =
        edit.mode === 'append' ? [...base, ...added.filter((word) => !base.includes(word))] : added;
      continue;
    }
    const text = Array.isArray(edit.value) ? edit.value.join(', ') : edit.value;
    const before = asText(existing);
    patch[edit.field] = edit.mode === 'append' && before !== '' ? `${before} ${text}`.trim() : text;
  }
  return patch as Partial<IptcFields>;
}
