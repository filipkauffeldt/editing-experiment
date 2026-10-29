import type { IptcFields, Photo } from '@ee/contracts';

/** Library collections: smart groups across every folder. */
export type Collection = 'tagged' | 'sent' | 'edited';

export const COLLECTIONS: readonly { id: Collection; label: string }[] = [
  { id: 'tagged', label: 'Tagged' },
  { id: 'sent', label: 'Sent' },
  { id: 'edited', label: 'Edited' },
];

/** The quick filters the Library offers; "Not sent" is `not-uploaded` in the store. */
export type LibraryQuick = 'all' | 'tagged' | 'untagged' | 'not-uploaded';

export const LIBRARY_QUICK: readonly { id: LibraryQuick; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tagged', label: 'Tagged' },
  { id: 'untagged', label: 'Untagged' },
  { id: 'not-uploaded', label: 'Not sent' },
];

export const THUMB_SIZE_RANGE = { min: 96, max: 280, default: 160 } as const;

export interface LibraryState {
  /** Folder (directory of the local copy) shown in the grid; absent means every folder. */
  folder?: string;
  collection?: Collection;
  quick: LibraryQuick;
  /** 1..8, or absent for any class. */
  colorClass?: number;
  view: 'grid' | 'loupe';
  thumbSize: number;
}

export const initialLibrary = (): LibraryState => ({
  quick: 'all',
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

export function inCollection(photo: Photo, collection: Collection): boolean {
  switch (collection) {
    case 'tagged':
      return photo.tagged;
    case 'sent':
      return photo.status.upload === 'done';
    case 'edited':
      return photo.status.edited || photo.versions.some((version) => version.kind === 'retouch');
  }
}

export function matchesLibrary(photo: Photo, library: LibraryState): boolean {
  if (library.folder !== undefined && folderOf(photo.path) !== library.folder) return false;
  if (library.collection && !inCollection(photo, library.collection)) return false;
  switch (library.quick) {
    case 'tagged':
      if (!photo.tagged) return false;
      break;
    case 'untagged':
      if (photo.tagged) return false;
      break;
    case 'not-uploaded':
      if (photo.status.upload === 'done') return false;
      break;
    case 'all':
      break;
  }
  return library.colorClass === undefined || photo.colorClass === library.colorClass;
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
