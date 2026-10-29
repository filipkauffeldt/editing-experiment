import { join } from 'node:path';

/** Where the backend keeps its files under the Electron `userData` directory. */
export interface UserDataLayout {
  root: string;
  /** Sources, destinations, ingest, export presets and active preset (JSON). */
  settingsFile: string;
  /** Photo index (`node:sqlite`); a cache, sidecars are the source of truth. */
  indexDb: string;
  /** Files already ingested per source (`node:sqlite`). */
  seenDb: string;
  /** Upload queue (`node:sqlite`). */
  uploadsDb: string;
  /** Resumable export batches (JSON). */
  exportJobsFile: string;
  /** Paths the app has exported; the only files `overwrite` may replace. */
  exportedFilesFile: string;
  /** Imported develop presets (one JSON file each). */
  presetsDir: string;
  /** Everything below is disposable cache. */
  cacheDir: string;
  thumbDir: string;
  previewDir: string;
  linearDir: string;
  /** Exported JPEGs, one folder per photo. */
  exportsDir: string;
}

export function userDataLayout(root: string): UserDataLayout {
  const cacheDir = join(root, 'cache');
  return {
    root,
    settingsFile: join(root, 'settings.json'),
    indexDb: join(root, 'index.sqlite'),
    seenDb: join(root, 'seen.sqlite'),
    uploadsDb: join(root, 'uploads.sqlite'),
    exportJobsFile: join(root, 'export-jobs.json'),
    exportedFilesFile: join(root, 'exported-files.json'),
    presetsDir: join(root, 'presets'),
    cacheDir,
    thumbDir: join(cacheDir, 'thumb'),
    previewDir: join(cacheDir, 'preview'),
    linearDir: join(cacheDir, 'linear'),
    exportsDir: join(root, 'exports'),
  };
}
