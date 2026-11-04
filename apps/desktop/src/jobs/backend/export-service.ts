import {
  IpcError,
  type ExportPreset,
  type ExportState,
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
import { EXPORT_MARKER_NAME, EXPORT_MARKER_TEXT } from '@ee/ingest';
import {
  asString,
  expandVariables,
  readIptc,
  writeIptc,
  type ExifToolService,
  type CaptionContext,
} from '@ee/metadata';
import { constants } from 'node:fs';
import { access, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path, { dirname, join, parse } from 'node:path';
import { captureInstant, hasZone, setModifiedTime } from './export-file-time';
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
  // Burst order and the zone of the clock live in these; the dates alone lose both.
  'EXIF:SubSecTimeOriginal',
  'EXIF:SubSecTimeDigitized',
  'EXIF:OffsetTimeOriginal',
  'EXIF:OffsetTimeDigitized',
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
  /** Something went wrong that does not fail the export. Defaults to `console.warn`. */
  warn?(message: string): void;
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

    // Before anything reads the photo: a missing folder should say so, not "metadata file not found".
    if (startsWithPhotoFolder(preset.folderTemplate)) {
      await assertPhotoFolderAvailable(dirname(photo.path), photo.fileName).catch((error) => {
        this.setStatus(photo.id, { export: 'failed' });
        throw error;
      });
    }

    // The sidecar may be mid-edit; wait for that to finish so the export carries what the user sees.
    let fields: IptcFields = {};
    try {
      fields = await photos.withLock(photo.id, () => readIptc(photo.path, exiftool));
    } catch (error) {
      if (preset.metadata !== 'none') throw error;
    }
    const context = contextFor(photo.path, photo.fileName, fields, photo.captureTime, photo.camera);
    const target = resolveExportTarget(preset, context, settings.get().exportRoot);
    const outputDir = target.folder;
    const fileName = resolveExportFileName(preset, context);
    const originals = this.originalPaths();

    this.setStatus(photo.id, { export: 'encoding' });
    try {
      await this.prepareFolder(target, photo.fileName);
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
          writeMetadata: (jpegPath) =>
            this.writeMetadata(jpegPath, photo.path, preset, fields, photo.captureTime),
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

  /**
   * A cancelled or render-failed job must not leave an older Exported badge
   * behind. The file may still exist, but this attempt produced none.
   */
  clearExportState(photoId: PhotoId): void {
    this.exportFields.delete(photoId);
    this.setStatus(photoId, { export: 'none' });
  }

  /**
   * Make the export folder ready, with errors that name the folder. The photo's own folder is
   * only checked, never created (see {@link assertPhotoFolderAvailable}).
   */
  private async prepareFolder(target: ResolvedExportFolder, fileName: string): Promise<void> {
    const { folder, photoFolder } = target;
    // Checked again: the drive can go between reading the metadata and writing.
    if (photoFolder !== undefined) await assertPhotoFolderAvailable(photoFolder, fileName);
    try {
      await mkdir(folder, { recursive: true });
      await access(folder, constants.W_OK);
    } catch (error) {
      throw new IpcError(
        'io',
        `Cannot export ${fileName}: the folder ${folder} is not writable (${errorCode(error)}).`,
        { cause: error },
      );
    }
    if (!this.wantsMarker(folder, photoFolder !== undefined)) return;
    // The marker keeps exports out of ingest and the startup scan, also when the exported-files
    // list is gone.
    try {
      await writeFile(join(folder, EXPORT_MARKER_NAME), EXPORT_MARKER_TEXT, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new IpcError(
          'io',
          `Cannot export ${fileName}: the folder ${folder} is not writable (${errorCode(error)}).`,
          { cause: error },
        );
      }
    }
  }

  /**
   * Whether the folder gets the export marker: it is below a photo's folder (or the template said
   * so), where the startup scan and a folder source would find it. Never a folder that holds
   * photos, as the marker would hide them; and not a folder somewhere else, which is the user's.
   */
  private wantsMarker(folder: string, nextToPhoto: boolean): boolean {
    const key = normalizeExportPath(folder);
    let below = nextToPhoto;
    for (const photo of this.deps.photos.list()) {
      for (const file of [photo.path, photo.sidecarPath]) {
        const directory = normalizeExportPath(dirname(file));
        if (directory === key) return false;
        const relation = path.relative(directory, key);
        if (
          relation !== '' &&
          relation !== '..' &&
          !relation.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relation)
        ) {
          below = true;
        }
      }
    }
    return below;
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
    captureTime: string | undefined,
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
    // Last, because ExifTool's rewrites above reset the modified time. The file
    // is then renamed into place, which keeps it.
    if (preset.metadata === 'all' || preset.metadata === 'iptc') {
      await this.stampCaptureTime(tempPath, sourcePath, captureTime);
    }
  }

  /** Makes the file's modified time the camera's capture time, as a file manager would sort by. */
  private async stampCaptureTime(
    file: string,
    sourcePath: string,
    captureTime: string | undefined,
  ): Promise<void> {
    const warn = this.deps.warn ?? ((message: string) => console.warn(message));
    let offset: string | undefined;
    if (captureTime !== undefined && !hasZone(captureTime)) {
      try {
        const tags = await this.deps.exiftool.read(sourcePath);
        offset = asString(tags['ExifIFD:OffsetTimeOriginal'] ?? tags['ExifIFD:OffsetTime']);
      } catch (error) {
        warn(`could not read the UTC offset of ${sourcePath}: ${String(error)}`);
      }
    }
    const when = captureInstant(captureTime, offset);
    if (when !== undefined) await setModifiedTime(file, when, warn);
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
    change: Partial<{ export: ExportState; upload: UploadState }>,
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

/**
 * `rendering`/`encoding` are only true while a job is alive. Clear one left by
 * a crash so a restarted app does not spin forever; a restored queued job
 * shows its own spinner from the export list.
 */
export function clearInterruptedExportStates(photos: PhotoLibrary): void {
  for (const photo of photos.list()) {
    if (photo.status.export !== 'rendering' && photo.status.export !== 'encoding') continue;
    photos.update(photo.id, (current) => ({
      ...current,
      status: { ...current.status, export: 'none' },
    }));
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
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
    photoFolder: dirname(filePath),
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

/** A template that starts with `{photofolder}` (the only place it may appear). */
const PHOTO_FOLDER_START = /^\s*\{\s*photofolder\s*\}/i;
const PHOTO_FOLDER_ANYWHERE = /\{\s*photofolder\s*\}/i;

export function startsWithPhotoFolder(folderTemplate: string): boolean {
  return PHOTO_FOLDER_START.test(folderTemplate);
}

/**
 * The photo's own folder is never created. A missing one means the drive is unplugged or the
 * folder was moved, and creating the path again would put the export on whatever disk now holds
 * that path (or on the system disk under an empty mount point).
 */
async function assertPhotoFolderAvailable(photoFolder: string, fileName: string): Promise<void> {
  const isFolder = await stat(photoFolder).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (isFolder) return;
  throw new IpcError(
    'io',
    `Cannot export ${fileName}: its folder ${photoFolder} is not available. ` +
      'Connect the drive, or move the folder back.',
  );
}

export interface ResolvedExportFolder {
  folder: string;
  /**
   * Set when the template starts with `{photofolder}`: the folder holding the photo. `folder` is
   * at or below it, and it must already exist (it is never created).
   */
  photoFolder?: string;
}

/**
 * Where a photo's export goes.
 *
 * - Starts with `{photofolder}`: the photo's own folder plus the rest of the template. The
 *   result must be at or below that folder; the rest comes from metadata variables, which can
 *   hold `..`, `/` or `C:\`, so it is checked after expansion, not trusted.
 * - Another absolute template is used as it is.
 * - A relative template lives below `exportRoot` and may not escape it.
 *
 * `pathApi` is `node:path` unless a test needs the other platform's rules.
 */
export function resolveExportTarget(
  preset: ExportPreset,
  context: CaptionContext,
  exportRoot: string,
  pathApi: path.PlatformPath = path,
): ResolvedExportFolder {
  const template = preset.folderTemplate;
  if (PHOTO_FOLDER_START.test(template)) {
    const rest = template.replace(PHOTO_FOLDER_START, '');
    if (PHOTO_FOLDER_ANYWHERE.test(rest)) {
      throw new IpcError(
        'invalid_argument',
        '{photofolder} can only be at the start of the folder template',
      );
    }
    if (context.filePath === undefined || !pathApi.isAbsolute(context.filePath)) {
      throw new IpcError('invalid_argument', 'the photo has no absolute path to export next to');
    }
    const photoFolder = pathApi.dirname(context.filePath);
    // Leading separators would make the rest absolute; `{photofolder}/export` is the normal spelling.
    const below = expandTemplate(rest, preset, context)
      .trim()
      .replace(pathApi.sep === '\\' ? /^[\\/]+/ : /^\/+/, '');
    const folder = pathApi.resolve(photoFolder, below);
    const relation = pathApi.relative(photoFolder, folder);
    if (
      relation === '..' ||
      relation.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relation)
    ) {
      throw new IpcError(
        'invalid_argument',
        `the folder template leaves the photo's folder ${photoFolder}`,
      );
    }
    return { folder, photoFolder };
  }
  if (PHOTO_FOLDER_ANYWHERE.test(template)) {
    throw new IpcError(
      'invalid_argument',
      '{photofolder} can only be at the start of the folder template',
    );
  }
  const expanded = expandTemplate(template, preset, context).trim();
  if (expanded === '') throw new IpcError('invalid_argument', 'the folder template is empty');
  if (pathApi.isAbsolute(expanded)) return { folder: pathApi.normalize(expanded) };
  const root = pathApi.resolve(exportRoot);
  const target = pathApi.resolve(root, expanded);
  if (target !== root && !target.startsWith(`${root}${pathApi.sep}`)) {
    throw new IpcError('invalid_argument', 'the folder template escapes the export root');
  }
  return { folder: target };
}

/** The folder only; see {@link resolveExportTarget}. */
export function resolveExportFolder(
  preset: ExportPreset,
  context: CaptionContext,
  exportRoot: string,
  pathApi: path.PlatformPath = path,
): string {
  return resolveExportTarget(preset, context, exportRoot, pathApi).folder;
}

export function resolveExportFileName(preset: ExportPreset, context: CaptionContext): string {
  if (preset.fileNaming === 'keep') {
    // The photo's current base name with the export format's extension. A raw
    // and its JPEG pair share that base, so `ifExists` decides which wins.
    const kept = `${context.fileNameBase}.jpg`;
    assertSafeFileName(kept);
    return kept;
  }
  const expanded = expandTemplate(preset.fileNameTemplate, preset, context).trim();
  if (expanded === '') throw new IpcError('invalid_argument', 'the file name template is empty');
  // A template without an extension gets the preset's JPEG extension; an explicit
  // extension is kept so the target check can protect e.g. a sidecar name.
  const fileName = parse(expanded).ext === '' ? `${expanded}.jpg` : expanded;
  assertSafeFileName(fileName);
  return fileName;
}
