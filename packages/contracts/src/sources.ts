import type { PresetId, SourceId } from './ids';

/** Fields shared by every ingest source. */
interface SourceBase {
  id: SourceId;
  /** Display name. */
  name: string;
}

/** Which files a local source copies. */
export type FileTypeFilter = 'raw' | 'jpeg' | 'both';

/**
 * Which protect/read-only states a local source copies. `locked` is the
 * camera's protect button (the file's read-only attribute).
 */
export type LockFilter = 'locked' | 'unlocked' | 'all';

/**
 * Per-source ingest filters. These apply to local folders and cards only;
 * remote sources have no readable protect attribute.
 */
export interface LocalSourceFilters {
  /**
   * `raw` copies the supported raw formats plus their `.xmp` sidecars, `jpeg`
   * copies `.jpg`/`.jpeg`, and `both` (the default) copies every supported
   * image, including HEIF/TIFF only in this mode.
   */
  fileTypes?: FileTypeFilter;
  /** Defaults to `all`. A raw/JPEG pair is locked when either file is locked. */
  lockFilter?: LockFilter;
  /**
   * Skip files already ingested from this source (path, size and modification
   * time). Defaults to `true`; when off, copies are renamed with a numeric
   * suffix instead of overwriting.
   */
  incremental?: boolean;
}

/** A plain local folder treated as a source. */
export interface FolderSource extends SourceBase, LocalSourceFilters {
  kind: 'folder';
  path: string;
  /** Descend into subfolders (default false). */
  recursive?: boolean;
}

/** A memory card (removable volume). Detection is platform specific; see `sources:detectCards`. */
export interface CardSource extends SourceBase, LocalSourceFilters {
  kind: 'card';
  /** Mount point of the volume (e.g. `/run/media/user/NIKON_Z9`, `E:\`). */
  mountPath: string;
  volumeLabel?: string;
}

/** Connection fields shared by remote sources and destinations. */
export interface RemoteEndpoint {
  host: string;
  port: number;
  username: string;
  /**
   * Opaque reference to a secret stored in the main process via Electron
   * `safeStorage` (see `credentials:set`). The secret itself never crosses IPC
   * towards the renderer and is never logged.
   *
   * Absent or empty means **anonymous** (FTP only): the connection uses
   * `anonymous` with a conventional email as password. Never put a plaintext
   * password here; the reference points at encrypted storage.
   */
  credentialRef?: string;
}

/** Fields shared by polled remote sources (FTP/FTPS/SFTP). */
interface RemoteSourceBase extends SourceBase, RemoteEndpoint {
  /** Directory on the server to watch. */
  remotePath: string;
  /** How often to list the remote directory, in milliseconds. */
  pollIntervalMs: number;
  /**
   * Delete files on the server after a verified download. Destructive:
   * defaults to `false` and must only ever be enabled by an explicit user choice.
   */
  deleteAfterDownload: boolean;
}

/** TLS mode of an FTP connection. */
export type FtpSecurity = 'none' | 'explicit-tls' | 'implicit-tls';

/** FTP or FTPS server polled for new files. */
export interface FtpSource extends RemoteSourceBase {
  kind: 'ftp';
  security: FtpSecurity;
}

/** SFTP server polled for new files. */
export interface SftpSource extends RemoteSourceBase {
  kind: 'sftp';
  /** Pinned host key fingerprint (`SHA256:...`); trust-on-first-use fills it in. */
  hostKeyFingerprint?: string;
}

/** Any configured ingest source, discriminated by `kind`. */
export type SourceConfig = FolderSource | CardSource | FtpSource | SftpSource;

/** A removable volume that looks like a camera card, reported by `sources:detectCards`. */
export interface DetectedCard {
  mountPath: string;
  volumeLabel?: string;
  /** Number of image files found under `DCIM`, if it was cheap to count. */
  imageCount?: number;
}

/** Where ingested files are copied to. */
export interface IngestDestination {
  /** Absolute base folder. */
  path: string;
  /**
   * Optional subfolder template under `path`, expanded per photo with the same
   * `{variables}` as the rename template (e.g. `{date}/{sourceName}`).
   */
  subfolderTemplate?: string;
}

/** How a metadata template merges into existing metadata. */
export type TemplateApplyMode = 'replace' | 'fillEmpty';

/** Everything `ingest:start` needs. All sources run in parallel, each in filename order. */
export interface IngestConfig {
  sources: SourceConfig[];
  destination: IngestDestination;
  /** Second copy made alongside the primary one; failure to write it fails the file. */
  backupDestination?: IngestDestination;
  /** File name template without extension, e.g. `{date}_{event}_{seq:4}`. */
  renameTemplate: string;
  /** Photo Mechanic style `.XMP` metadata template applied to every ingested photo. */
  metadataTemplatePath?: string;
  /**
   * How the template merges into metadata the file already has. Defaults to
   * `replace` so camera-written fields (e.g. copyright/artist) are corrected.
   */
  metadataTemplateMode?: TemplateApplyMode;
  /** Imported develop preset applied to every ingested photo; absent means none. */
  developPresetId?: PresetId;
  /** Tab-delimited code replacement files, later files override earlier ones. */
  codeReplacementPaths: string[];
}
