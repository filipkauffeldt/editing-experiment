import {
  IpcError,
  type ExportPreset,
  type IptcFields,
  type JobEvent,
  type PhotoId,
  type RenderedImage,
  type UploadId,
  type UploadItem,
  type UploadState,
  type DestinationId,
} from '@ee/contracts';
import {
  assertSafeFileName,
  exportPhoto,
  type ExpandPathTemplate,
  type UploadQueue,
} from '@ee/export';
import {
  expandVariables,
  readIptc,
  writeIptc,
  type ExifToolService,
  type CaptionContext,
} from '@ee/metadata';
import { isAbsolute, parse, resolve, sep } from 'node:path';
import path from 'node:path';
import { rename } from 'node:fs/promises';
import type { ExportedFileStore } from './exported-files';
import { normalizeExportPath } from './exported-files';
import type { PhotoLibrary } from './photo-library';
import type { SettingsStore } from './settings-store';

/** Most photos whose latest upload batch is remembered at once. */
const MAX_TRACKED_BATCHES = 500;

/** Camera/exposure tags carried from the original into an `all` export. */
const EXIF_TAGS = [
  'EXIF:DateTimeOriginal',
  'EXIF:CreateDate',
  'EXIF:Make',
  'EXIF:Model',
  'EXIF:LensModel',
  'EXIF:LensInfo',
  'EXIF:FNumber',
  'EXIF:ExposureTime',
  'EXIF:ISO',
  'EXIF:FocalLength',
  'EXIF:FocalLengthIn35mmFormat',
  'EXIF:ExposureProgram',
  'EXIF:ExposureCompensation',
  'EXIF:Flash',
  'EXIF:MeteringMode',
  'EXIF:WhiteBalance',
  'EXIF:Artist',
  'EXIF:Copyright',
] as const;

/** Location tags, copied only when the preset does not ask to strip GPS. */
const GPS_TAGS = [
  'EXIF:GPSLatitude',
  'EXIF:GPSLatitudeRef',
  'EXIF:GPSLongitude',
  'EXIF:GPSLongitudeRef',
  'EXIF:GPSAltitude',
  'EXIF:GPSAltitudeRef',
  'EXIF:GPSDateStamp',
  'EXIF:GPSTimeStamp',
] as const;

export interface ExportOneArgs {
  photoId: PhotoId;
  preset: ExportPreset;
  rendered: RenderedImage;
}

export interface ExportedFile {
  path: string;
  fileName: string;
  skipped?: boolean;
}

export interface ExportServiceDeps {
  photos: PhotoLibrary;
  settings: SettingsStore;
  exiftool: ExifToolService;
  queue: UploadQueue;
  /** Absolute paths the app exported; only these may be overwritten. */
  exportedFiles: ExportedFileStore;
  /** Forward queue events (progress, state) to the renderer. */
  onEvent(event: JobEvent): void;
}

/**
 * Encodes one renderer-produced full-resolution render to a JPEG, writes it
 * below the preset's expanded folder template, checks that no preview leaked,
 * and (separately) hands it to the upload queue.
 */
export class ExportService {
  /** IPTC read for a photo's latest export, for the remote path template. */
  private readonly exportFields = new Map<PhotoId, IptcFields>();
  /** Uploads of a photo's latest export; older ones do not count towards its status. */
  private readonly latestBatch = new Map<PhotoId, Set<UploadId>>();

  constructor(private readonly deps: ExportServiceDeps) {
    deps.queue.events.on((event) => {
      deps.onEvent(event);
      if (event.type === 'upload.state') this.refreshUploadStatus(event.photoId);
    });
  }

  /** Path-template expander for the queue: capture date and IPTC fields of the photo. */
  readonly expandPathTemplate: ExpandPathTemplate = (template, context) => {
    let photo;
    try {
      photo = this.deps.photos.get(context.photoId);
    } catch {
      return template;
    }
    return expandVariables(template, {
      fileName: context.fileName,
      fileNameBase: context.filenamebase,
      ...(photo.captureTime === undefined ? {} : { captureTime: photo.captureTime }),
      ...(photo.camera === undefined ? {} : { camera: photo.camera }),
      fields: this.exportFields.get(context.photoId) ?? {},
    }).text;
  };

  async exportOne(args: ExportOneArgs): Promise<ExportedFile> {
    const { photos, settings, exiftool } = this.deps;
    const { photoId, preset } = args;
    const photo = photos.get(photoId);
    const { rendered } = args;
    validateRendered(rendered);

    // The sidecar may be mid-edit; wait for that to finish so the export carries what the user sees.
    let fields: IptcFields = {};
    try {
      fields = await photos.withLock(photo.id, () => readIptc(photo.path, exiftool));
    } catch (error) {
      if (preset.metadata !== 'none') throw error;
    }
    const context = contextFor(photo.path, photo.fileName, fields, photo.captureTime, photo.camera);
    const outputDir = resolveExportFolder(preset, context, settings.get().exportRoot);
    const fileName = resolveExportFileName(preset, context);
    const originals = this.originalPaths();

    this.setStatus(photo.id, { export: 'encoding' });
    try {
      const exported = await exportPhoto({
        image: rendered,
        preset,
        outputDir,
        fileName,
        photoId: photo.id,
        ifExists: preset.ifExists,
        canOverwrite: (target) => this.deps.exportedFiles.has(target),
        checkTarget: (target) => this.assertNotOriginal(target, originals),
        hooks: {
          writeMetadata: (jpegPath) => this.writeMetadata(jpegPath, photo.path, preset, fields),
        },
      });
      if (exported.skipped !== true) this.deps.exportedFiles.add(exported.path);
      this.setStatus(photo.id, { export: 'done' });
      // Only needed until the queue has expanded the remote paths in `enqueue`.
      this.exportFields.set(photo.id, fields);
      return {
        path: exported.path,
        fileName: path.basename(exported.path),
        ...(exported.skipped === true ? { skipped: true } : {}),
      };
    } catch (error) {
      this.exportFields.delete(photo.id);
      this.setStatus(photo.id, { export: 'failed' });
      throw error;
    }
  }

  /** Sends an already exported file to the given destinations. */
  async enqueue(
    photoId: PhotoId,
    localPath: string,
    destinationIds: readonly DestinationId[],
  ): Promise<UploadItem[]> {
    const destinations = destinationIds.map((id) => {
      const destination = this.deps.settings.getDestination(id);
      if (!destination) throw new IpcError('not_found', `no destination ${id}`);
      return destination;
    });
    try {
      const uploads = await this.deps.queue.enqueue(photoId, localPath, destinations);
      this.trackBatch(photoId, new Set(uploads.map((upload) => upload.id)));
      this.refreshUploadStatus(photoId);
      return uploads;
    } finally {
      this.exportFields.delete(photoId);
    }
  }

  /** Forget the fields for an export that never reached the queue. */
  discard(photoId: PhotoId): void {
    this.exportFields.delete(photoId);
  }

  /** Every indexed original and sidecar, case-folded on case-insensitive file systems. */
  private originalPaths(): Set<string> {
    const paths = new Set<string>();
    for (const photo of this.deps.photos.list()) {
      paths.add(normalizeExportPath(photo.path));
      paths.add(normalizeExportPath(photo.sidecarPath));
    }
    return paths;
  }

  private assertNotOriginal(target: string, originals: ReadonlySet<string>): void {
    if (!originals.has(normalizeExportPath(target))) return;
    throw new IpcError(
      'invalid_argument',
      `Refusing to export over the ingested photo or sidecar at ${target}`,
    );
  }

  /**
   * ExifTool picks the format from the extension, but the export writes to a
   * hidden `.tmp` name first, so give it a `.jpg` name for the write.
   */
  private async writeMetadata(
    tempPath: string,
    sourcePath: string,
    preset: ExportPreset,
    fields: IptcFields,
  ): Promise<void> {
    if (preset.metadata === 'none') return;
    const named = `${tempPath}.jpg`;
    await rename(tempPath, named);
    try {
      if (preset.metadata === 'all') {
        const tags = preset.stripGps ? EXIF_TAGS : [...EXIF_TAGS, ...GPS_TAGS];
        await this.deps.exiftool.copyTags(named, sourcePath, tags);
      }
      const written =
        preset.metadata === 'copyright'
          ? fields.copyright === undefined
            ? {}
            : { copyright: fields.copyright }
          : fields;
      await writeIptc(named, written, { service: this.deps.exiftool });
    } finally {
      await rename(named, tempPath);
    }
  }

  /** What is still being remembered per photo; the maps must not grow with every export. */
  trackedCounts(): { fields: number; batches: number } {
    return { fields: this.exportFields.size, batches: this.latestBatch.size };
  }

  private trackBatch(photoId: PhotoId, batch: Set<UploadId>): void {
    this.latestBatch.delete(photoId);
    this.latestBatch.set(photoId, batch);
    // Batches with failed uploads stay so a retry keeps counting; bound them anyway.
    while (this.latestBatch.size > MAX_TRACKED_BATCHES) {
      const oldest = this.latestBatch.keys().next();
      if (oldest.done) break;
      this.latestBatch.delete(oldest.value);
    }
  }

  private refreshUploadStatus(photoId: PhotoId): void {
    const batch = this.latestBatch.get(photoId);
    const items = this.deps.queue
      .list()
      .filter((item) => item.photoId === photoId && (!batch || batch.has(item.id)))
      .filter((item) => item.state !== 'cancelled');
    // Everything delivered (or cancelled): nothing left to follow for this photo.
    if (batch && items.every((item) => item.state === 'done')) this.latestBatch.delete(photoId);
    let upload: UploadState = 'none';
    if (items.length > 0) {
      if (items.some((item) => item.state === 'uploading')) upload = 'uploading';
      else if (items.some((item) => item.state === 'queued')) upload = 'queued';
      else if (items.some((item) => item.state === 'failed')) upload = 'failed';
      else upload = 'done';
    }
    this.setStatus(photoId, { upload });
  }

  private setStatus(
    photoId: PhotoId,
    change: Partial<{ export: 'encoding' | 'done' | 'failed'; upload: UploadState }>,
  ): void {
    const { photos } = this.deps;
    try {
      const current = photos.get(photoId).status;
      if (
        (change.export ?? current.export) === current.export &&
        (change.upload ?? current.upload) === current.upload
      ) {
        return;
      }
      photos.update(photoId, (photo) => ({ ...photo, status: { ...photo.status, ...change } }));
    } catch (error) {
      // Queue events can outlive the index entry; nothing to update then.
      if (!(error instanceof IpcError && error.code === 'not_found')) throw error;
    }
  }
}

function validateRendered(rendered: RenderedImage): void {
  if (
    !(rendered?.rgba instanceof Uint8Array) ||
    !Number.isInteger(rendered.width) ||
    !Number.isInteger(rendered.height) ||
    rendered.rgba.length !== rendered.width * rendered.height * 4
  ) {
    throw new IpcError('invalid_argument', 'rendered must be width*height*4 bytes of RGBA');
  }
}

function contextFor(
  filePath: string,
  fileName: string,
  fields: IptcFields,
  captureTime: string | undefined,
  camera: { make?: string; model?: string; lens?: string; serialNumber?: string } | undefined,
  now: Date = new Date(),
): CaptionContext {
  return {
    filePath,
    fileName,
    fileNameBase: parse(fileName).name,
    ...(captureTime === undefined ? {} : { captureTime }),
    ...(camera === undefined ? {} : { camera }),
    fields,
    now,
  };
}

/** `{preset}` is not a metadata variable; escape it before expansion. */
function presetName(preset: ExportPreset): string {
  const safe = preset.name.replace(/[\\/:*?"<>|]/g, '-').replace(/^[-\s]+|[-\s]+$/g, '');
  return safe === '' ? preset.id : safe;
}

function expandTemplate(template: string, preset: ExportPreset, context: CaptionContext): string {
  return expandVariables(template.replaceAll('{preset}', presetName(preset)), context).text;
}

/** Absolute templates are used as-is; relative ones live below `exportRoot`. */
export function resolveExportFolder(
  preset: ExportPreset,
  context: CaptionContext,
  exportRoot: string,
): string {
  const expanded = expandTemplate(preset.folderTemplate, preset, context).trim();
  if (expanded === '') throw new IpcError('invalid_argument', 'the folder template is empty');
  if (isAbsolute(expanded)) return path.normalize(expanded);
  const root = resolve(exportRoot);
  const target = resolve(root, expanded);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new IpcError('invalid_argument', 'the folder template escapes the export root');
  }
  return target;
}

export function resolveExportFileName(preset: ExportPreset, context: CaptionContext): string {
  const expanded = expandTemplate(preset.fileNameTemplate, preset, context).trim();
  if (expanded === '') throw new IpcError('invalid_argument', 'the file name template is empty');
  // A template without an extension gets the preset's JPEG extension; an explicit
  // extension is kept so the target check can protect e.g. a sidecar name.
  const fileName = parse(expanded).ext === '' ? `${expanded}.jpg` : expanded;
  assertSafeFileName(fileName);
  return fileName;
}
