import {
  IpcError,
  type ExportPhotoArgs,
  type ExportPhotoResult,
  type IptcFields,
  type JobEvent,
  type PhotoId,
  type UploadId,
  type UploadState,
} from '@ee/contracts';
import { exportPhoto, type ExpandPathTemplate, type UploadQueue } from '@ee/export';
import { expandVariables, readIptc, writeIptc, type ExifToolService } from '@ee/metadata';
import { rename } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { PhotoLibrary } from './photo-library';
import type { SettingsStore } from './settings-store';

export interface ExportServiceDeps {
  photos: PhotoLibrary;
  settings: SettingsStore;
  exiftool: ExifToolService;
  queue: UploadQueue;
  exportsDir: string;
  /** Forward queue events (progress, state) to the renderer. */
  onEvent(event: JobEvent): void;
}

/**
 * "Finish": encode the renderer's full-resolution render to a JPEG with the
 * photo's IPTC, check that no preview leaked, then hand it to the upload queue.
 * It also keeps `status.export` / `status.upload` of the photo current.
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

  async export(args: ExportPhotoArgs): Promise<ExportPhotoResult> {
    const { photos, settings, exiftool, queue } = this.deps;
    const photo = photos.get(args.photoId);
    const { rendered } = args;
    if (
      !(rendered?.rgba instanceof Uint8Array) ||
      !Number.isInteger(rendered.width) ||
      !Number.isInteger(rendered.height) ||
      rendered.rgba.length !== rendered.width * rendered.height * 4
    ) {
      throw new IpcError('invalid_argument', 'rendered must be width*height*4 bytes of RGBA');
    }
    const action = args.action ?? settings.get().finishAction;
    const destinations = action.destinations.map((id) => {
      const destination = settings.getDestination(id);
      if (!destination) throw new IpcError('not_found', `no destination ${id}`);
      return destination;
    });

    const fields =
      action.exportPreset.metadata === 'none' ? {} : await readIptc(photo.path, exiftool);
    this.exportFields.set(photo.id, fields);
    this.setStatus(photo.id, { export: 'encoding' });
    let exported;
    try {
      exported = await exportPhoto({
        image: rendered,
        preset: action.exportPreset,
        outputDir: join(this.deps.exportsDir, photo.id),
        fileName: `${parse(photo.fileName).name}.jpg`,
        photoId: photo.id,
        hooks: { writeMetadata: (jpegPath) => this.writeIptcInto(jpegPath, fields) },
      });
    } catch (error) {
      this.setStatus(photo.id, { export: 'failed' });
      throw error;
    }
    this.setStatus(photo.id, { export: 'done' });

    const uploads = await queue.enqueue(photo.id, exported.path, destinations);
    this.latestBatch.set(photo.id, new Set(uploads.map((upload) => upload.id)));
    this.refreshUploadStatus(photo.id);
    return { path: exported.path, uploads };
  }

  /**
   * ExifTool picks the format from the extension, but the export writes to a
   * hidden `.tmp` name first, so give it a `.jpg` name for the write.
   */
  private async writeIptcInto(tempPath: string, fields: IptcFields): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    const named = `${tempPath}.jpg`;
    await rename(tempPath, named);
    try {
      await writeIptc(named, fields, { service: this.deps.exiftool });
    } finally {
      await rename(named, tempPath);
    }
  }

  private refreshUploadStatus(photoId: PhotoId): void {
    const batch = this.latestBatch.get(photoId);
    const items = this.deps.queue
      .list()
      .filter((item) => item.photoId === photoId && (!batch || batch.has(item.id)))
      .filter((item) => item.state !== 'cancelled');
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
