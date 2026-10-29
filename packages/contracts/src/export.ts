import type { DestinationId, ExportJobId, PhotoId, PresetId, UploadId } from './ids';
import type { FtpSecurity, RemoteEndpoint } from './sources';

/**
 * Which metadata is embedded in the exported JPEG.
 *
 * - `all`: IPTC/XMP plus the original's EXIF camera and GPS tags.
 * - `iptc`: IPTC/XMP only.
 * - `copyright`: only the copyright field.
 * - `none`: no metadata at all.
 */
export type ExportMetadataMode = 'all' | 'iptc' | 'copyright' | 'none';

/** Output file format. Only JPEG is implemented; TIFF can slot in here later. */
export type ExportFormat = 'jpeg';

/** What to do when the target file already exists. */
export type ExportIfExists = 'suffix' | 'overwrite' | 'skip';

/** Where the exported image is placed. */
export type ExportVersion = 'top' | 'develop';

/** Output pixel dimensions, expressed the way Lightroom's export dialog does. */
export type ExportResize =
  | { mode: 'none' }
  | { mode: 'longEdge'; pixels: number }
  | { mode: 'shortEdge'; pixels: number }
  | { mode: 'megapixels'; megapixels: number };

/** Which medium the output sharpening is tuned for. `none` disables it. */
export type ExportSharpeningTarget = 'none' | 'screen' | 'matte' | 'glossy';
/** How strongly output sharpening is applied. */
export type ExportSharpeningAmount = 'low' | 'standard' | 'high';

export interface ExportOutputSharpening {
  target: ExportSharpeningTarget;
  amount: ExportSharpeningAmount;
}

/**
 * How a photo is exported. The renderer always produces full resolution; the
 * jobs process resizes, sharpens, encodes and writes metadata from this.
 */
export interface ExportPreset {
  id: PresetId;
  name: string;
  /**
   * Directory template, relative to `AppSettings.exportRoot` unless absolute.
   * `{variables}` come from `@ee/metadata`; `{preset}` expands to the preset name.
   */
  folderTemplate: string;
  /** File name template (without a directory); `.jpg` is appended when missing. */
  fileNameTemplate: string;
  ifExists: ExportIfExists;
  format: ExportFormat;
  /** JPEG quality, 1..100. */
  quality: number;
  colorSpace: 'srgb';
  resize: ExportResize;
  outputSharpening: ExportOutputSharpening;
  metadata: ExportMetadataMode;
  stripGps: boolean;
  /** Which edit version is rendered: the newest retouch version, or develop only. */
  version: ExportVersion;
  /** Destinations used by Export & send / Next & send; empty means export only. */
  sendTo: DestinationId[];
}

/** Lifecycle of one export job. */
export type ExportJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** Progress of one photo inside an export job. */
export type ExportPhotoState =
  'queued' | 'rendering' | 'exporting' | 'sending' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface ExportPhotoProgress {
  photoId: PhotoId;
  state: ExportPhotoState;
  /** Absolute path of the exported (or skipped existing) file. */
  path?: string;
  error?: string;
}

/** One background export batch. */
export interface ExportJob {
  id: ExportJobId;
  presetId: PresetId;
  photoIds: PhotoId[];
  /** Destinations to send to after each successful export; empty = export only. */
  send: DestinationId[];
  state: ExportJobState;
  /** Effective render version: send actions always use the top retouch version. */
  version: ExportVersion;
  photos: ExportPhotoProgress[];
  createdAt: number;
  finishedAt?: number;
  error?: string;
}

/** A request from the jobs process asking the renderer for one full-resolution render. */
export interface ExportRenderRequest {
  jobId: ExportJobId;
  requestId: string;
  photoId: PhotoId;
  presetId: PresetId;
  /** Retouch ops to apply: none for `develop`, the newest retouch version for `top`. */
  version: ExportVersion;
  /** {@link retouchOpsKey} of the ops the jobs process expects this render to apply. */
  opsKey: string;
}

/** Arguments of `export:start`. */
export interface StartExportArgs {
  photoIds: PhotoId[];
  presetId: PresetId;
  /** Overrides the preset's `sendTo`; `[]` exports without uploading. */
  send?: DestinationId[];
  /** Export & send / Next & send force the top retouch version, even for a develop-only preset. */
  forceTop?: boolean;
}

/** Arguments of `export:render`: the renderer's reply to an {@link ExportRenderRequest}. */
export interface DeliverExportRenderArgs {
  jobId: ExportJobId;
  requestId: string;
  rendered?: RenderedImage;
  /** Key of the ops the renderer actually applied; must match the request. */
  opsKey?: string;
  /** Set instead of `rendered` when the renderer could not render the photo. */
  error?: string;
}

/** Fields shared by every destination. */
interface DestinationBase {
  id: DestinationId;
  name: string;
  /**
   * Path template for the uploaded file, directories and file name together,
   * expanded per photo with `{variables}` (e.g. `/incoming/{date}/{fileName}`).
   * For folder destinations it is relative to `path`.
   */
  remotePathTemplate: string;
}

/** Export into a local folder. */
export interface FolderDestination extends DestinationBase {
  kind: 'folder';
  path: string;
}

/** Upload to an FTP or FTPS server. */
export interface FtpDestination extends DestinationBase, RemoteEndpoint {
  kind: 'ftp';
  security: FtpSecurity;
}

/** Upload to an SFTP server. */
export interface SftpDestination extends DestinationBase, RemoteEndpoint {
  kind: 'sftp';
  hostKeyFingerprint?: string;
}

/** Any configured destination, discriminated by `kind`. */
export type Destination = FolderDestination | FtpDestination | SftpDestination;

/** Secret material for a source or destination. Only ever sent renderer → main. */
export interface CredentialSecret {
  password?: string;
  /** PEM private key for SFTP. */
  privateKey?: string;
  passphrase?: string;
}

/**
 * A full-resolution render produced by the renderer's GL pipeline, handed to
 * the jobs process for encoding.
 */
export interface RenderedImage {
  width: number;
  height: number;
  /** Tightly packed RGBA, 8 bits per channel, sRGB, row 0 at the top. Length = width*height*4. */
  rgba: Uint8Array;
}

/** Lifecycle of an upload queue entry. */
export type UploadItemState = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';

/** One file waiting for, or being sent to, one destination. */
export interface UploadItem {
  id: UploadId;
  photoId: PhotoId;
  destinationId: DestinationId;
  /** Local file being uploaded (the exported JPEG). */
  localPath: string;
  /** Expanded remote path. */
  remotePath: string;
  state: UploadItemState;
  bytesSent: number;
  bytesTotal: number;
  attempts: number;
  /** Last error message, when `state` is `failed`. Never contains credentials. */
  error?: string;
}
