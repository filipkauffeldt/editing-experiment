import type { SourceId } from './ids';

/** Fields shared by every ingest source. */
interface SourceBase {
  id: SourceId;
  /** Display name. */
  name: string;
}

/** A plain local folder treated as a source. */
export interface FolderSource extends SourceBase {
  kind: 'folder';
  path: string;
  /** Descend into subfolders (default false). */
  recursive?: boolean;
}

/** A memory card (removable volume). Detection is platform specific; see `sources:detectCards`. */
export interface CardSource extends SourceBase {
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
  /** Tab-delimited code replacement files, later files override earlier ones. */
  codeReplacementPaths: string[];
}
