import type { IptcFields, LibraryFolderInfo, Photo, PhotoId } from '@ee/contracts';

export const THUMB_SIZE_RANGE = { min: 96, max: 280, default: 160 } as const;

export interface LibraryState {
  /** Folder (directory of the local copy) shown in the grid; absent means every folder. */
  folder?: string;
  view: 'grid' | 'loupe' | 'compare';
  /** The photos side by side while `view` is `compare`, and the pane the keys act on. */
  compare?: CompareState;
  thumbSize: number;
}

export interface CompareState {
  /** Two to four photos, in the grid's order. */
  ids: PhotoId[];
  activeId: PhotoId;
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
  /** Photos directly in the folder, or below an added root. */
  count: number;
  /** True for a folder the user added in place; it can be rescanned and removed with its subfolders. */
  root?: boolean;
}

/** A path key that compares the same folder regardless of separator style or a trailing slash. */
function folderKey(path: string): string {
  const key = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return key === '' ? '/' : key;
}

/** Whether `child` is `parent` or a folder below it; both are photo/folder paths as stored. */
export function folderIsAtOrBelow(parent: string, child: string): boolean {
  const parentKey = folderKey(parent);
  const childKey = folderKey(child);
  if (parentKey === '/') return childKey.startsWith('/');
  return parentKey === childKey || childKey.startsWith(`${parentKey}/`);
}

/**
 * The local folders that hold photos, from the photos themselves, plus every folder the user added
 * in place even when its photos are all in subfolders. Sources are not consulted. An added root's
 * count is every photo below it, because removing it removes the whole tree.
 */
export function libraryFolders(
  photos: readonly Photo[],
  addedFolders: readonly string[] = [],
): LibraryFolder[] {
  const counts = new Map<string, number>();
  for (const photo of photos) {
    const folder = folderOf(photo.path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const folders = new Map<string, LibraryFolder>();
  for (const [path, count] of counts) {
    folders.set(path, { path, name: baseName(path), count });
  }
  const seenRoots = new Set<string>();
  for (const root of addedFolders) {
    const key = folderKey(root);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    const count = photos.filter((photo) => folderIsAtOrBelow(root, folderOf(photo.path))).length;
    const existing = folders.get(root);
    if (existing) {
      existing.count = count;
      existing.root = true;
    } else {
      folders.set(root, { path: root, name: baseName(root), count, root: true });
    }
  }
  return disambiguateNames(
    [...folders.values()].sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { numeric: true }),
    ),
  );
}

/**
 * The sidebar from the index's folder tree. The counts come from the jobs process, so a large
 * index never puts every photo in the renderer just to count a folder.
 */
export function libraryFoldersFromInfos(folders: readonly LibraryFolderInfo[]): LibraryFolder[] {
  return disambiguateNames(
    folders
      .filter((folder) => folder.count > 0 || folder.root === true)
      .map((folder) => ({
        path: folder.path,
        name: baseName(folder.path),
        count: folder.count,
        ...(folder.root === true ? { root: true } : {}),
      }))
      .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true })),
  );
}

/**
 * Two roots can hold folders of the same name (`/card/2026/game` and `/archive/2026/game`). Show
 * the shortest parent suffix that tells them apart, so the sidebar never lists two identical
 * rows.
 */
function disambiguateNames(folders: LibraryFolder[]): LibraryFolder[] {
  const segments = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean);
  const suffix = (path: string, depth: number): string => {
    const parts = segments(path);
    return parts.slice(Math.max(0, parts.length - depth)).join('/');
  };
  return folders.map((folder) => {
    const others = folders.filter((candidate) => candidate.path !== folder.path);
    let depth = 1;
    while (
      depth <= segments(folder.path).length &&
      others.some((other) => suffix(other.path, depth) === suffix(folder.path, depth))
    ) {
      depth += 1;
    }
    return { ...folder, name: suffix(folder.path, depth) };
  });
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
