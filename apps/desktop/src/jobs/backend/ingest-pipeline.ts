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
  sidecarPathFor,
  toIsoDate,
  type ExifToolService,
} from '@ee/metadata';
import { copyFile } from 'node:fs/promises';
import sharp from 'sharp';
import { trace } from './trace';
import type { EditService } from './edit-service';
import type { MetadataService } from './metadata-service';
import type { PhotoLibrary } from './photo-library';
import type { PreviewCache, PreviewSource } from './previews';
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
  preview?: PreviewSource;
}

/** EXIF orientations 5..8 swap width and height. */
const swapsAxes = (orientation: number | undefined): boolean =>
  orientation !== undefined && orientation >= 5 && orientation <= 8;

async function readRaw(path: string): Promise<Basics> {
  trace(`readRawInfo+extractPreview ${path}`);
  const [info, preview] = await Promise.allSettled([readRawInfo(path), extractPreview(path)]);
  trace('read done');
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
  const [tags, meta] = await Promise.all([
    exiftool.read(path),
    sharp(path, { failOn: 'none' }).metadata(),
  ]);
  const captureTime = toIsoDate(tags['ExifIFD:DateTimeOriginal'] ?? tags['IFD0:ModifyDate']);
  const make = asString(tags['IFD0:Make']);
  const model = asString(tags['IFD0:Model']);
  const lens = asString(tags['ExifIFD:LensModel']);
  const serial = asString(tags['ExifIFD:BodySerialNumber']);
  const width = meta.width ?? asNumber(tags['File:ImageWidth']);
  const height = meta.height ?? asNumber(tags['File:ImageHeight']);
  const [w, h] = swapsAxes(meta.orientation) ? [height, width] : [width, height];
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
        trace('sharp preview start');
        await previews.generate(info.photoId, basics.preview);
        trace('sharp preview done');
      } catch (error) {
        problem('preview', error);
      }
    }

    let differs = false;
    const templatePath = config.metadataTemplatePath;
    if (templatePath) {
      try {
        trace('template start');
        ({ differs } = await metadata.applyToFile(info.path, templatePath, mode));
        trace('template done');
        await mirrorToBackup(info);
      } catch (error) {
        problem('metadata', error);
      }
    }

    const sidecarPath = raw ? sidecarPathFor(info.path) : info.path;
    // A sidecar that came with the file may already hold edits.
    const versions = info.sidecarPath
      ? await edits.readVersions(info.path, info.photoId).catch((error: unknown) => {
          problem('metadata', error);
          return undefined;
        })
      : undefined;
    const photo: Photo = {
      id: info.photoId,
      path: info.path,
      sidecarPath,
      fileName: info.fileName,
      ...(basics.captureTime === undefined ? {} : { captureTime: basics.captureTime }),
      ...(basics.camera === undefined ? {} : { camera: basics.camera }),
      ...(basics.width === undefined ? {} : { width: basics.width }),
      ...(basics.height === undefined ? {} : { height: basics.height }),
      sourceId: info.sourceId,
      status: {
        ingest: 'done',
        edited: versions !== undefined && versionsEdited(versions),
        metadataDiffersFromTemplate: differs,
        export: 'none',
        upload: 'none',
      },
      versions: versions ?? [{ id: developVersionId(info.photoId), kind: 'develop', ops: {} }],
    };
    // Reconciliation and a normal ingest can reach the same file; index it once.
    if (photos.hasPath(info.path)) return;
    try {
      trace('index add');
      photos.add(photo, templatePath);
      trace('index added');
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
