import type { DestinationId, PhotoId, UploadId } from './ids';
import type { FtpSecurity, RemoteEndpoint } from './sources';

/** Which metadata is embedded in the exported JPEG. */
export type ExportMetadataMode = 'all' | 'iptc' | 'none';

/**
 * How a finished photo is encoded. Whatever the preset, the output never
 * contains an embedded thumbnail/preview of the unretouched image.
 */
export interface ExportPreset {
  /** Longest edge in pixels; absent = full resolution. */
  maxEdge?: number;
  /** JPEG quality, 1..100. */
  quality: number;
  metadata: ExportMetadataMode;
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

/** What "Finish & next" does: encode with `exportPreset`, then deliver to every destination. */
export interface FinishAction {
  exportPreset: ExportPreset;
  destinations: DestinationId[];
}

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
