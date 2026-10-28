import {
  type CameraInfo,
  type IngestConfig,
  type JobEvent,
  type Photo,
  type TemplateApplyMode,
} from '@ee/contracts';
import { readRawInfo, extractPreview } from '@ee/core';
import type { IngestedFileInfo, OnFileIngested } from '@ee/ingest';
import {
  asNumber,
  asString,
  isRawPath,
  readPhotoLabels,
  sidecarPathFor,
  toIsoDate,
  type ExifToolService,
} from '@ee/metadata';
import { copyFile } from 'node:fs/promises';
import type { EditService } from './edit-service';
import type { MetadataService } from './metadata-service';
import type { PhotoLibrary } from './photo-library';
import type { PreviewSource } from './image-ops';
import type { PreviewCache } from './previews';
import { developVersionId, versionsEdited } from './edit-service';

export interface IngestPipelineDeps {
  photos: PhotoLibrary;
  previews: PreviewCache;
  metadata: MetadataService;
  edits: EditService;
  exiftool: ExifToolService;
  /** Report a problem that does not stop the file from being indexed. */
  report(event: Omit<Extract<JobEvent, { type: 'job.error' }>, 'type' | 'at'>): void;
}

interface Basics {
  captureTime?: string;
  camera?: CameraInfo;
  width?: number;
  height?: number;
  orientation?: number;
  preview?: PreviewSource;
}

const validOrientation = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isInteger(value) && value >= 1 && value <= 8 ? value : undefined;

async function readRaw(path: string): Promise<Basics> {
  const [info, preview] = await Promise.allSettled([readRawInfo(path), extractPreview(path)]);
  const basics: Basics = {};
  if (preview.status === 'fulfilled') {
    basics.preview = { jpeg: preview.value.jpeg, orientation: preview.value.orientation };
  }
  if (info.status === 'rejected') throw info.reason;
  const raw = info.value;
  basics.camera = {
    make: raw.make,
    model: raw.model,
    ...(raw.lens === undefined ? {} : { lens: raw.lens }),
    ...(raw.serial === undefined ? {} : { serialNumber: raw.serial }),
  };
  if (raw.captureTime !== undefined) basics.captureTime = raw.captureTime;
  basics.width = raw.width;
  basics.height = raw.height;
  const orientation = validOrientation(raw.orientation);
  if (orientation !== undefined) basics.orientation = orientation;
  if (preview.status === 'rejected') throw new PreviewError(preview.reason, basics);
  return basics;
}

/** Carries what was read before the preview failed, so the photo is still indexed. */
class PreviewError extends Error {
  constructor(
    readonly reason: unknown,
    readonly basics: Basics,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

async function readImage(path: string, exiftool: ExifToolService): Promise<Basics> {
  const tags = await exiftool.read(path);
  const captureTime = toIsoDate(tags['ExifIFD:DateTimeOriginal'] ?? tags['IFD0:ModifyDate']);
  const make = asString(tags['IFD0:Make']);
  const model = asString(tags['IFD0:Model']);
  const lens = asString(tags['ExifIFD:LensModel']);
  const serial = asString(tags['ExifIFD:BodySerialNumber']);
  // ExifTool reports the stored size; orientations 5..8 display it turned.
  const stored = [asNumber(tags['File:ImageWidth']), asNumber(tags['File:ImageHeight'])] as const;
  const orientationValue = validOrientation(asNumber(tags['IFD0:Orientation']));
  const [w, h] =
    orientationValue !== undefined && orientationValue >= 5 && orientationValue <= 8
      ? [stored[1], stored[0]]
      : stored;
  return {
    ...(captureTime === undefined ? {} : { captureTime }),
    ...(make || model || lens || serial
      ? {
          camera: {
            ...(make ? { make } : {}),
            ...(model ? { model } : {}),
            ...(lens ? { lens } : {}),
            ...(serial ? { serialNumber: serial } : {}),
          },
        }
      : {}),
    ...(w === undefined ? {} : { width: w }),
    ...(h === undefined ? {} : { height: h }),
    ...(orientationValue === undefined ? {} : { orientation: orientationValue }),
    preview: { file: path },
  };
}

/**
 * What happens to each file after ingest has copied and verified it, in order:
 * read camera data, cache preview and thumbnail, apply the metadata template,
 * index it, announce it. Ingest awaits this per source, so photos reach the
 * index (and the film strip) in the order the files were copied.
 *
 * Failures of the optional steps (preview, template) are reported and the photo
 * is still indexed: the copy on disk is good and must not vanish from the UI.
 */
export function createOnFileIngested(
  deps: IngestPipelineDeps,
  config: Pick<IngestConfig, 'metadataTemplatePath'>,
  mode: TemplateApplyMode,
): OnFileIngested {
  const { photos, previews, metadata, edits, exiftool, report } = deps;

  return async (info: IngestedFileInfo): Promise<void> => {
    if (photos.hasPath(info.path)) return;
    const raw = isRawPath(info.path);
    const problem = (scope: string, error: unknown): void =>
      report({
        jobId: info.jobId,
        scope,
        message: `${info.fileName}: ${error instanceof Error ? error.message : String(error)}`,
      });

    let basics: Basics;
    try {
      basics = raw ? await readRaw(info.path) : await readImage(info.path, exiftool);
    } catch (error) {
      if (error instanceof PreviewError) {
        basics = error.basics;
        problem('preview', error.reason);
      } else {
        basics = {};
        problem('metadata', error);
      }
    }

    if (basics.preview) {
      try {
        await previews.generate(info.photoId, basics.preview);
      } catch (error) {
        problem('preview', error);
      }
    }

    let differs = false;
    const templatePath = config.metadataTemplatePath;
    if (templatePath) {
      try {
        ({ differs } = await metadata.applyToFile(info.path, templatePath, mode));
        await mirrorToBackup(info);
      } catch (error) {
        problem('metadata', error);
      }
    }

    const sidecarPath = raw ? sidecarPathFor(info.path) : info.path;
    const labels = await readPhotoLabels(info.path, { service: exiftool }).catch(() => ({
      tagged: false,
      colorClass: 0,
    }));
    // A sidecar that came with the file may already hold edits.
    const versions = info.sidecarPath
      ? await edits
          .readVersions(info.path, info.photoId, {
            ...(basics.orientation === undefined ? {} : { orientation: basics.orientation }),
            ...(basics.width === undefined ? {} : { width: basics.width }),
            ...(basics.height === undefined ? {} : { height: basics.height }),
          })
          .catch((error: unknown) => {
            problem('metadata', error);
            return undefined;
          })
      : undefined;
    const edited = versions !== undefined && versionsEdited(versions);
    const photo: Photo = {
      id: info.photoId,
      path: info.path,
      sidecarPath,
      fileName: info.fileName,
      ...(basics.captureTime === undefined ? {} : { captureTime: basics.captureTime }),
      ...(basics.camera === undefined ? {} : { camera: basics.camera }),
      ...(basics.width === undefined ? {} : { width: basics.width }),
      ...(basics.height === undefined ? {} : { height: basics.height }),
      ...(basics.orientation === undefined ? {} : { orientation: basics.orientation }),
      sourceId: info.sourceId,
      tagged: labels.tagged,
      colorClass: labels.colorClass,
      status: {
        ingest: 'done',
        edited,
        metadataDiffersFromTemplate: differs,
        export: 'none',
        upload: 'none',
      },
      versions: versions ?? [{ id: developVersionId(info.photoId), kind: 'develop', ops: {} }],
      // The camera preview shows none of it; the renderer draws the edited one when first needed.
      ...(edited ? { previewStale: true } : {}),
    };
    // Reconciliation and a normal ingest can reach the same file; index it once.
    if (photos.hasPath(info.path)) return;
    try {
      photos.add(photo, templatePath);
    } catch (error) {
      // The file is copied and verified but will not show up; say so, and where it is.
      problem(
        'index',
        new Error(
          `copied to ${info.path} but could not be added to the photo index: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      throw error;
    }
  };
}

/** The backup copy gets the same sidecar (raw) or the same embedded metadata (JPEG). */
async function mirrorToBackup(info: IngestedFileInfo): Promise<void> {
  if (!info.backupPath) return;
  if (isRawPath(info.path)) {
    await copyFile(sidecarPathFor(info.path), sidecarPathFor(info.backupPath));
  } else {
    await copyFile(info.path, info.backupPath);
  }
}
