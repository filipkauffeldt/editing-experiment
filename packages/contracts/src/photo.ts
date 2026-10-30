import type { EditParams } from './develop';
import type { PhotoId, SourceId, VersionId } from './ids';
import type { RetouchOp } from './retouch';

/** Camera information read from EXIF. */
export interface CameraInfo {
  make?: string;
  model?: string;
  lens?: string;
  serialNumber?: string;
  /** ISO speed. */
  iso?: number;
  /** Focal length in millimetres. */
  focalLength?: number;
  /** F-number. */
  aperture?: number;
  /** Exposure time in seconds. */
  shutter?: number;
}

/** Where a photo is in the ingest pipeline. */
export type IngestState = 'pending' | 'copying' | 'verifying' | 'done' | 'failed';
/** Export (full-resolution render + encode) state. */
export type ExportState = 'none' | 'rendering' | 'encoding' | 'done' | 'failed';
/** Upload state of the photo's most recent export, aggregated over destinations. */
export type UploadState = 'none' | 'queued' | 'uploading' | 'done' | 'failed';

/** Per-photo progress flags shown as badges in the film strip. */
export interface PhotoStatus {
  ingest: IngestState;
  /** Develop or retouch edits exist. */
  edited: boolean;
  /** Embedded/sidecar metadata no longer matches the template applied at ingest. */
  metadataDiffersFromTemplate: boolean;
  export: ExportState;
  upload: UploadState;
}

/** A develop variant of a photo: a full set of {@link EditParams}. */
export interface DevelopVersion {
  id: VersionId;
  kind: 'develop';
  name?: string;
  ops: EditParams;
}

/** A retouch variant of a photo: an ordered list of {@link RetouchOp}s applied after develop. */
export interface RetouchVersion {
  id: VersionId;
  kind: 'retouch';
  name?: string;
  ops: RetouchOp[];
}

/** An edit version of a photo, persisted in the sidecar (`crs:` for develop, `ee:` for retouch). */
export type PhotoVersion = DevelopVersion | RetouchVersion;

/** One ingested photo. The index is a cache; the sidecar is the source of truth. */
export interface Photo {
  id: PhotoId;
  /** Absolute path of the ingested original in the ingest destination. Never modified. */
  path: string;
  /** Absolute path of the XMP sidecar (raws) or `path` itself (JPEG with embedded XMP). */
  sidecarPath: string;
  fileName: string;
  /** Capture time as ISO 8601; local time without offset when the camera recorded none. */
  captureTime?: string;
  camera?: CameraInfo;
  /** Pixel size of the oriented full-resolution image, once known. */
  width?: number;
  height?: number;
  /**
   * EXIF orientation (1..8) of the original pixels, once known. `crs:Crop*`
   * settings in the sidecar are stored in that pre-orientation space, while
   * `EditParams.crop` and `width`/`height` are in the oriented space; the
   * backend converts between the two.
   */
  orientation?: number;
  sourceId: SourceId;
  status: PhotoStatus;
  /** Photo Mechanic style tag flag, persisted in the sidecar (`photomechanic:Tagged`). */
  tagged: boolean;
  /** Colour class, 0 = none, 1..8 (Photo Mechanic `ColorClass`, mirrored to `xmp:Label`). */
  colorClass: number;
  /** Star rating, 0 = none, 1..5 (`xmp:Rating` and Photo Mechanic's `Prefs`). */
  rating: number;
  versions: PhotoVersion[];
  /**
   * Bumps whenever the cached thumbnail/preview bytes change (an edited
   * render stored, or reverted to the camera's preview). Put it in the URL
   * (`appUrl.thumb(id, revision)`) so an `<img>` refreshes.
   */
  previewRevision?: number;
  /**
   * The photo has edits that the cached thumbnail/preview do not show yet.
   * The renderer re-renders them; absent means nothing is waiting.
   */
  previewStale?: boolean;
}
