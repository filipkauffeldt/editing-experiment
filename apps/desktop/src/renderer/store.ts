import {
  applyPreset as mergePreset,
  constrainCrop,
  cropFromGeometry,
  cropGeometry,
  isFullCrop,
  largestCropForAspect,
  resizeCropFromHandle,
  sanitizeCrop,
  type CropHandle,
} from '@ee/develop-gl';
import {
  SLIDER_SPECS,
  type AppSettings,
  type CredentialSecret,
  type CropParams,
  type Destination,
  type EditParams,
  type EditPreset,
  type EeBridge,
  type IngestJobInfo,
  type IngestSettings,
  type IptcFields,
  type JobEvent,
  type Photo,
  type PhotoId,
  type MosaicOp,
  type Rect,
  type Shape,
  type SourceConfig,
  type SourceId,
  type TemplateApplyMode,
  type UploadItem,
  type VersionId,
} from '@ee/contracts';
import { renderFullResolution } from './export-render';
import { padFaceBox } from './retouch-geometry';

export type QuickFilter =
  'all' | 'untagged' | 'tagged' | 'edited' | 'not-uploaded' | 'failed-uploads' | 'metadata-differs';

export const QUICK_FILTERS: readonly { id: QuickFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'untagged', label: 'Untagged' },
  { id: 'tagged', label: 'Tagged' },
  { id: 'edited', label: 'Edited' },
  { id: 'not-uploaded', label: 'Not uploaded' },
  { id: 'failed-uploads', label: 'Failed uploads' },
  { id: 'metadata-differs', label: 'Metadata differs' },
];

export type SortMode = 'filename' | 'capture-time';
export type DialogTab = 'sources' | 'destinations' | 'ingest' | 'finish';

export interface FilterState {
  quick: QuickFilter;
  camera?: string;
  sourceId?: SourceId;
}

export interface PhotoFlags {
  tagged: boolean;
  /** 0 = none, 1..8 = colour class. */
  colorClass: number;
}

/** Which gesture the retouch overlay currently records. */
export type RetouchTool = 'rect' | 'lasso' | 'wand' | 'faces';

/** A detected face, with the padded box that is actually mosaicked when enabled. */
export interface RetouchFace {
  /** Raw detector box in normalized image coordinates; padding is applied when rendering. */
  box: Rect;
  score?: number;
  enabled: boolean;
}

/** The retouch editing session for one photo. */
export interface RetouchSession {
  photoId: PhotoId;
  /** Existing retouch version being edited; absent until the first commit. */
  versionId?: VersionId;
  tool: RetouchTool;
  /** Mosaic block edge relative to the longer image edge. */
  blockSizeRel: number;
  /** Magic-wand colour tolerance (CIE76, 0..100). */
  tolerance: number;
  /**
   * Extra padding around detected faces as a fraction of the box width.
   * Height padding is 1.4x this and biased upward to cover hair.
   */
  facePadding: number;
  shapes: Shape[];
  faces: RetouchFace[];
  busy: boolean;
}

/** The aspect presets in the crop toolbar. */
export type CropAspectId = 'original' | 'free' | '3:2' | '4:3' | '16:9' | '1:1' | '4:5';

export const CROP_ASPECTS: readonly { id: CropAspectId; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: '3:2', label: '3:2' },
  { id: '4:3', label: '4:3' },
  { id: '16:9', label: '16:9' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' },
  { id: 'free', label: 'Free' },
];

const CROP_ASPECT_RATIOS: Readonly<Record<Exclude<CropAspectId, 'original' | 'free'>, number>> = {
  '3:2': 3 / 2,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
  '1:1': 1,
  '4:5': 4 / 5,
};

/** The crop editing session for one photo. Nothing is saved until Enter/apply. */
export interface CropSession {
  photoId: PhotoId;
  /** Oriented, uncropped image size in pixels. */
  image: { width: number; height: number };
  crop: CropParams;
  aspect: CropAspectId;
  /** Swaps the aspect preset's orientation (X), e.g. 3:2 → 2:3. */
  flipped: boolean;
  tool: 'crop' | 'straighten';
}

/** Pixel aspect ratio of a crop session, or undefined for Free. */
export function cropAspectRatio(session: CropSession): number | undefined {
  if (session.aspect === 'free') return undefined;
  if (session.aspect === 'original') {
    const base = session.image.width / session.image.height;
    return session.flipped ? 1 / base : base;
  }
  const base = CROP_ASPECT_RATIOS[session.aspect];
  return session.flipped ? 1 / base : base;
}

/** Progress of "Finish & next", shown in the status bar. */
export interface ExportProgress {
  label: string;
  /** 0..100 when known; absent for indeterminate work. */
  percent?: number;
}

export const DEFAULT_BLOCK_SIZE_REL = 0.012;
/** Default extra padding around a detected face (horizontal fraction; vertical is 1.4x). */
export const DEFAULT_FACE_PADDING = 0.25;

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'success';
  message: string;
}

export interface IngestRun {
  sourceId: SourceId;
  jobId: string;
  state: IngestJobInfo['state'];
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  error?: string;
}

export interface AppState {
  photos: Photo[];
  sources: SourceConfig[];
  destinations: Destination[];
  settings?: AppSettings;
  presets: EditPreset[];
  uploads: UploadItem[];
  ingest: Record<string, IngestRun>;
  metadata: Record<string, IptcFields>;
  metadataUnresolved: Record<string, string[]>;
  template?: IptcFields;
  templatePath?: string;
  editParams: Record<string, EditParams>;
  retouch?: RetouchSession;
  crop?: CropSession;
  exportProgress?: ExportProgress;
  selectedId?: PhotoId;
  filter: FilterState;
  sort: SortMode;
  toasts: Toast[];
  presetNotice?: string;
  dialog?: DialogTab;
  shortcutsOpen: boolean;
  loading: boolean;
  error?: string;
}

/** Key for one version's develop parameters. */
export function editParamsKey(photoId: PhotoId, versionId?: VersionId): string {
  return `${photoId}:${versionId ?? 'active'}`;
}

/** The develop version shown by the camera/develop panel. */
export function activeDevelopVersion(photo: Photo | undefined) {
  return photo?.versions.find((version) => version.kind === 'develop');
}

export function cameraKey(photo: Photo): string {
  const camera = photo.camera;
  if (!camera) return '';
  return [camera.model ?? camera.make ?? 'Unknown', camera.serialNumber ?? ''].join('|');
}

export function cameraLabel(key: string): string {
  const [model, serial] = key.split('|');
  return serial ? `${model} · ${serial}` : (model ?? key);
}

export function cameraOptions(photos: Photo[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const photo of photos) {
    const key = cameraKey(photo);
    if (key && !seen.has(key)) seen.set(key, cameraLabel(key));
  }
  return [...seen]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function sourceLabel(sources: SourceConfig[], sourceId: SourceId): string {
  return sources.find((source) => source.id === sourceId)?.name ?? sourceId;
}

export function activePhoto(state: AppState): Photo | undefined {
  return state.photos.find((photo) => photo.id === state.selectedId);
}

export function photoFlags(state: AppState, photoId: PhotoId): PhotoFlags {
  const photo = state.photos.find((candidate) => candidate.id === photoId);
  return { tagged: photo?.tagged ?? false, colorClass: photo?.colorClass ?? 0 };
}

/** The newest retouch version, which is the one "Finish & next" applies by default. */
export function topRetouchVersion(photo: Photo | undefined) {
  if (!photo) return undefined;
  for (let i = photo.versions.length - 1; i >= 0; i--) {
    const version = photo.versions[i];
    if (version?.kind === 'retouch') return version;
  }
  return undefined;
}

export function paramsForPhoto(state: AppState, photo: Photo | undefined): EditParams {
  if (!photo) return {};
  return state.editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)] ?? {};
}

function matchesQuickFilter(state: AppState, photo: Photo, quick: QuickFilter): boolean {
  switch (quick) {
    case 'all':
      return true;
    case 'untagged':
      return !photo.tagged;
    case 'tagged':
      return photo.tagged;
    case 'edited':
      return photo.status.edited;
    case 'not-uploaded':
      return photo.status.upload !== 'done';
    case 'failed-uploads':
      return photo.status.upload === 'failed';
    case 'metadata-differs':
      return photo.status.metadataDiffersFromTemplate;
  }
}

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const naturalName = (left: Photo, right: Photo): number =>
  NAME_COLLATOR.compare(left.fileName, right.fileName);

const captureTime = (photo: Photo): number => {
  const value = photo.captureTime ? Date.parse(photo.captureTime) : Number.NaN;
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
};

/** Photos after the quick/camera/source filters, in the chosen order. */
export function selectVisiblePhotos(state: AppState): Photo[] {
  const filtered = state.photos.filter((photo) => {
    if (!matchesQuickFilter(state, photo, state.filter.quick)) return false;
    if (state.filter.camera && cameraKey(photo) !== state.filter.camera) return false;
    if (state.filter.sourceId && photo.sourceId !== state.filter.sourceId) return false;
    return true;
  });
  return filtered.sort((left, right) => {
    if (state.sort === 'capture-time') {
      const byTime = captureTime(left) - captureTime(right);
      if (byTime !== 0) return byTime;
    }
    return naturalName(left, right);
  });
}

export interface UploadSummary {
  queued: number;
  uploading: number;
  done: number;
  failed: number;
  active: number;
}

export function uploadSummary(uploads: UploadItem[]): UploadSummary {
  const summary: UploadSummary = { queued: 0, uploading: 0, done: 0, failed: 0, active: 0 };
  for (const item of uploads) {
    if (item.state === 'queued') summary.queued += 1;
    else if (item.state === 'uploading') summary.uploading += 1;
    else if (item.state === 'done') summary.done += 1;
    else if (item.state === 'failed') summary.failed += 1;
  }
  summary.active = summary.queued + summary.uploading;
  return summary;
}

export function unsupportedSettings(preset: EditPreset): string[] {
  // The contract has no such field yet; read it defensively so the real
  // importer can add it without a renderer update.
  const value = (preset as EditPreset & { unsupported?: unknown }).unsupported;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const structuredCloneShape = (shape: Shape): Shape =>
  shape.type === 'rect' ? { ...shape } : { ...shape, points: shape.points.map((p) => ({ ...p })) };

const hasPendingRetouch = (session: RetouchSession | undefined): boolean =>
  session !== undefined &&
  (session.shapes.length > 0 || session.faces.some((face) => face.enabled));

/** Throttle for develop writes: first change goes out at once, then at most every 80 ms. */
const DEVELOP_THROTTLE_MS = 80;

interface VisibleCache {
  ids: PhotoId[];
  filter: FilterState;
  sort: SortMode;
}

interface DevelopThrottle {
  photoId: PhotoId;
  versionId?: VersionId;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending?: EditParams;
}

const emptyState = (): AppState => ({
  photos: [],
  sources: [],
  destinations: [],
  presets: [],
  uploads: [],
  ingest: {},
  metadata: {},
  metadataUnresolved: {},
  editParams: {},
  filter: { quick: 'all' },
  sort: 'filename',
  toasts: [],
  shortcutsOpen: false,
  loading: true,
});

/**
 * Small observable store. React subscribes through `useSyncExternalStore`;
 * tests can call the same actions with an in-memory bridge and inspect state.
 */
export class AppStore {
  private state: AppState = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly metadataTimers = new Map<PhotoId, ReturnType<typeof setTimeout>>();
  private readonly metadataWrites = new Map<PhotoId, Promise<void>>();
  private readonly metadataEditVersion = new Map<PhotoId, number>();
  private readonly pendingMetadata = new Map<PhotoId, Partial<IptcFields>>();
  private readonly developThrottles = new Map<string, DevelopThrottle>();
  private readonly paramWrites = new Map<string, Promise<void>>();
  private readonly paramEditVersion = new Map<string, number>();
  private readonly paramSequence = new Map<string, number>();
  private readonly labelWrites = new Map<PhotoId, Promise<void>>();
  private retouchCommit: Promise<Photo | undefined> | undefined;
  private readonly photoById = new Map<PhotoId, Photo>();
  private readonly photoPositions = new Map<PhotoId, number>();
  private readonly pendingPhotos = new Map<PhotoId, Photo>();
  private photoFlush: ReturnType<typeof setTimeout> | number | null = null;
  private visibleCache: VisibleCache | undefined;
  private beforeUnload: (() => void) | undefined;
  private toastId = 0;
  private started = false;
  private finishing = false;

  constructor(
    private readonly bridge: EeBridge,
    private readonly renderForExport: typeof renderFullResolution = renderFullResolution,
  ) {}

  readonly getState = (): AppState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private toast(kind: Toast['kind'], message: string): void {
    const id = ++this.toastId;
    this.set({ toasts: [...this.state.toasts, { id, kind, message }] });
    if (kind !== 'error') {
      setTimeout(() => this.dismissToast(id), 5000);
    }
  }

  /** Surface an operational message (e.g. a failed face detection) without a dialog. */
  readonly notify = (kind: Toast['kind'], message: string): void => this.toast(kind, message);

  // ---------------------------------------------------------------- lifecycle

  readonly init = async (): Promise<void> => {
    if (this.started) return;
    this.started = true;
    this.unsubscribers.push(
      this.bridge.on('photos:added', (photo) => this.queuePhoto(photo)),
      this.bridge.on('photos:updated', (photo) => this.queuePhoto(photo)),
      this.bridge.on('jobs:event', (event) => this.handleJobEvent(event)),
    );
    if (typeof window !== 'undefined') {
      this.beforeUnload = () => {
        this.flushQueuedPhotos();
        void this.flushPendingEdits();
      };
      window.addEventListener('beforeunload', this.beforeUnload);
    }
    await this.loadAll();
  };

  /**
   * Stop listening and write anything still sitting in a debounce/throttle.
   * Returns a promise so tests and the window teardown can wait for the last
   * writes to cross the bridge.
   */
  readonly dispose = async (): Promise<void> => {
    this.started = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.beforeUnload && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.beforeUnload);
      this.beforeUnload = undefined;
    }
    this.cancelPhotoFlush();
    this.flushQueuedPhotos();
    await this.flushPendingEdits();
  };

  private async loadAll(): Promise<void> {
    const [photos, sources, destinations, settings, presets, uploads, ingest] =
      await Promise.allSettled([
        this.bridge.invoke('photos:list'),
        this.bridge.invoke('sources:list'),
        this.bridge.invoke('destinations:list'),
        this.bridge.invoke('settings:get'),
        this.bridge.invoke('develop:listPresets'),
        this.bridge.invoke('upload:list'),
        this.bridge.invoke('ingest:status'),
      ]);

    const value = <T>(result: PromiseSettledResult<T>): T | undefined =>
      result.status === 'fulfilled' ? result.value : undefined;

    const loadedPhotos = [...(value(photos) ?? [])];
    const queued = [...this.pendingPhotos.values()];
    this.pendingPhotos.clear();
    for (const photo of queued) {
      const position = loadedPhotos.findIndex((candidate) => candidate.id === photo.id);
      if (position >= 0) loadedPhotos[position] = photo;
      else loadedPhotos.push(photo);
    }
    this.photoById.clear();
    this.photoPositions.clear();
    loadedPhotos.forEach((photo, index) => {
      this.photoById.set(photo.id, photo);
      this.photoPositions.set(photo.id, index);
    });
    this.visibleCache = undefined;
    const runs: Record<string, IngestRun> = {};
    for (const info of value(ingest) ?? []) {
      runs[info.sourceId] = {
        sourceId: info.sourceId,
        jobId: info.jobId,
        state: info.state,
        filesDone: info.filesDone,
        filesTotal: info.filesTotal,
        bytesDone: info.bytesDone,
        error: info.error,
      };
    }

    this.set({
      photos: loadedPhotos,
      sources: value(sources) ?? [],
      destinations: value(destinations) ?? [],
      settings: value(settings),
      presets: value(presets) ?? [],
      uploads: value(uploads) ?? [],
      ingest: runs,
      loading: false,
      error: photos.status === 'rejected' ? messageOf(photos.reason) : undefined,
    });

    const path = value(settings)?.ingest.metadataTemplatePath;
    if (path) void this.loadTemplate(path);

    const first = this.getVisiblePhotos()[0];
    if (first) this.select(first.id);
  }

  // ------------------------------------------------------------------- photos

  /**
   * Cache of the filtered/sorted photo ids. Upload and metadata events update
   * photo objects without changing membership or order, so the cached order is
   * reused and only the objects are re-mapped.
   */
  readonly getVisiblePhotos = (): Photo[] => {
    const { filter, sort } = this.state;
    const cache = this.visibleCache;
    if (cache && cache.filter === filter && cache.sort === sort) {
      return cache.ids
        .map((id) => this.photoById.get(id))
        .filter((photo): photo is Photo => photo !== undefined);
    }
    const result = selectVisiblePhotos(this.state);
    this.visibleCache = { ids: result.map((photo) => photo.id), filter, sort };
    return result;
  };

  private photoAffectsVisible(previous: Photo | undefined, next: Photo): boolean {
    if (!previous) return true;
    if (previous.tagged !== next.tagged) return true;
    if (previous.fileName !== next.fileName || previous.captureTime !== next.captureTime)
      return true;
    if (cameraKey(previous) !== cameraKey(next) || previous.sourceId !== next.sourceId) return true;
    switch (this.state.filter.quick) {
      case 'edited':
        return previous.status.edited !== next.status.edited;
      case 'not-uploaded':
        return (previous.status.upload === 'done') !== (next.status.upload === 'done');
      case 'failed-uploads':
        return (previous.status.upload === 'failed') !== (next.status.upload === 'failed');
      case 'metadata-differs':
        return (
          previous.status.metadataDiffersFromTemplate !== next.status.metadataDiffersFromTemplate
        );
      default:
        return false;
    }
  }

  private applyPhoto(photo: Photo, photos = [...this.state.photos]): Photo[] {
    const previous = this.photoById.get(photo.id);
    const position = this.photoPositions.get(photo.id);
    if (position === undefined) {
      this.photoPositions.set(photo.id, photos.length);
      photos.push(photo);
      this.visibleCache = undefined;
    } else {
      photos[position] = photo;
      if (this.photoAffectsVisible(previous, photo)) this.visibleCache = undefined;
    }
    this.photoById.set(photo.id, photo);
    return photos;
  }

  /** Internal status updates (metadata writes, upload events) apply at once. */
  private upsertPhoto(photo: Photo): void {
    // Keep a not-yet-flushed event from overwriting this newer object next frame.
    if (this.pendingPhotos.has(photo.id)) this.pendingPhotos.set(photo.id, photo);
    this.set({ photos: this.applyPhoto(photo) });
  }

  /**
   * Backend `photos:added` / `photos:updated` events are coalesced per frame.
   * A burst of ingest updates therefore produces one resize/sort, and repeated
   * events for the same id keep only the newest object.
   */
  private queuePhoto(photo: Photo): void {
    this.pendingPhotos.set(photo.id, photo);
    if (this.photoFlush !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      this.photoFlush = requestAnimationFrame(() => {
        this.photoFlush = null;
        this.flushQueuedPhotos();
      });
    } else {
      this.photoFlush = setTimeout(() => {
        this.photoFlush = null;
        this.flushQueuedPhotos();
      }, 16);
    }
  }

  private cancelPhotoFlush(): void {
    if (this.photoFlush === null) return;
    if (typeof cancelAnimationFrame === 'function' && typeof this.photoFlush === 'number') {
      cancelAnimationFrame(this.photoFlush);
    } else {
      clearTimeout(this.photoFlush as ReturnType<typeof setTimeout>);
    }
    this.photoFlush = null;
  }

  private flushQueuedPhotos(): void {
    if (this.pendingPhotos.size === 0) return;
    const queued = [...this.pendingPhotos.values()];
    this.pendingPhotos.clear();
    const photos = [...this.state.photos];
    for (const photo of queued) this.applyPhoto(photo, photos);
    this.set({ photos });
  }

  private applySelection(photoId: PhotoId | undefined): void {
    if (photoId === this.state.selectedId) return;
    this.set({ selectedId: photoId });
    if (!photoId) return;
    void this.loadMetadata(photoId);
    void this.loadParams(photoId);
  }

  readonly select = (photoId: PhotoId | undefined): void => {
    if (photoId === this.state.selectedId) return;
    if (this.state.crop && this.state.crop.photoId !== photoId) this.applyCrop();
    const session = this.state.retouch;
    if (session && session.photoId !== photoId) {
      // Never lose an unreviewed mosaic by navigating away. The commit path is
      // shared with Finish, so an in-flight save is awaited instead of duplicated.
      if (session.busy || hasPendingRetouch(session)) {
        void this.commitRetouch().then((photo) => {
          if (photo) this.applySelection(photoId);
        });
        return;
      }
      this.exitRetouch();
    }
    this.applySelection(photoId);
  };

  readonly selectRelative = (delta: number): void => {
    const photos = this.getVisiblePhotos();
    if (photos.length === 0) return;
    const index = photos.findIndex((photo) => photo.id === this.state.selectedId);
    const next = photos[Math.max(0, Math.min(photos.length - 1, index + delta))];
    if (next) this.select(next.id);
  };

  private ensureSelectionVisible(): void {
    const visible = this.getVisiblePhotos();
    if (visible.some((photo) => photo.id === this.state.selectedId)) return;
    const next = visible[0];
    if (next) this.select(next.id);
    else this.set({ selectedId: undefined });
  }

  readonly setQuickFilter = (quick: QuickFilter): void => {
    this.set({ filter: { ...this.state.filter, quick } });
    this.ensureSelectionVisible();
  };

  readonly setCameraFilter = (camera: string | undefined): void => {
    this.set({ filter: { ...this.state.filter, camera } });
    this.ensureSelectionVisible();
  };

  readonly setSourceFilter = (sourceId: SourceId | undefined): void => {
    this.set({ filter: { ...this.state.filter, sourceId } });
    this.ensureSelectionVisible();
  };

  readonly setSort = (sort: SortMode): void => {
    this.set({ sort });
  };

  /** Optimistically apply a label change to the photo objects in the store. */
  private applyLabelPatch(photoIds: PhotoId[], patch: Partial<PhotoFlags>): void {
    const wanted = new Set(photoIds);
    const photos = this.state.photos.map((photo) =>
      wanted.has(photo.id) ? { ...photo, ...patch } : photo,
    );
    for (const photo of photos) this.photoById.set(photo.id, photo);
    this.visibleCache = undefined;
    this.set({ photos });
  }

  private persistLabels(photoIds: PhotoId[], patch: Partial<PhotoFlags>): void {
    for (const photoId of photoIds) {
      const previous = this.labelWrites.get(photoId) ?? Promise.resolve();
      const write = previous
        .then(() =>
          this.bridge.invoke('photos:setLabels', {
            photoIds: [photoId],
            ...patch,
          }),
        )
        .then((photos) => {
          for (const photo of photos) this.upsertPhoto(photo);
        })
        .catch((cause: unknown) => {
          this.toast('error', `Could not save labels: ${messageOf(cause)}`);
        })
        .finally(() => {
          if (this.labelWrites.get(photoId) === write) this.labelWrites.delete(photoId);
        });
      this.labelWrites.set(photoId, write);
    }
  }

  readonly toggleTag = (photoId?: PhotoId): void => {
    const id = photoId ?? this.state.selectedId;
    if (!id) return;
    const photo = this.photoById.get(id);
    if (!photo) return;
    const tagged = !photo.tagged;
    this.applyLabelPatch([id], { tagged });
    this.persistLabels([id], { tagged });
    this.ensureSelectionVisible();
  };

  readonly setColorClass = (colorClass: number, photoId?: PhotoId): void => {
    const id = photoId ?? this.state.selectedId;
    if (!id || !Number.isInteger(colorClass) || colorClass < 0 || colorClass > 8) return;
    this.applyLabelPatch([id], { colorClass });
    this.persistLabels([id], { colorClass });
  };

  // ------------------------------------------------------------------ retouch

  /** Enter retouch mode for the selected photo; leaving saves pending shapes first. */
  readonly toggleRetouch = (): void => {
    // Crop and retouch are mutually exclusive; the R shortcut must not sneak
    // past the disabled button while cropping.
    if (this.state.crop) return;
    if (this.state.retouch) {
      void this.requestExitRetouch();
      return;
    }
    const photo = activePhoto(this.state);
    if (!photo) return;
    const version = topRetouchVersion(photo);
    const op = version?.ops.find((candidate): candidate is MosaicOp => candidate.type === 'mosaic');
    this.set({
      retouch: {
        photoId: photo.id,
        ...(version ? { versionId: version.id } : {}),
        tool: 'rect',
        blockSizeRel: op?.blockSizeRel ?? DEFAULT_BLOCK_SIZE_REL,
        tolerance: 24,
        facePadding: DEFAULT_FACE_PADDING,
        shapes: op ? op.shapes.map((shape) => structuredCloneShape(shape)) : [],
        faces: [],
        busy: false,
      },
    });
  };

  readonly setRetouchTool = (tool: RetouchTool): void => {
    if (!this.state.retouch) return;
    this.set({ retouch: { ...this.state.retouch, tool } });
  };

  readonly setRetouchBlockSize = (blockSizeRel: number): void => {
    if (!this.state.retouch || !(blockSizeRel > 0)) return;
    this.set({ retouch: { ...this.state.retouch, blockSizeRel } });
  };

  readonly setRetouchTolerance = (tolerance: number): void => {
    if (!this.state.retouch) return;
    this.set({ retouch: { ...this.state.retouch, tolerance: Math.max(0, tolerance) } });
  };

  readonly setRetouchFacePadding = (facePadding: number): void => {
    if (!this.state.retouch || !(facePadding >= 0)) return;
    this.set({
      retouch: { ...this.state.retouch, facePadding: Math.min(0.5, facePadding) },
    });
  };

  readonly addRetouchShape = (shape: Shape): void => {
    if (!this.state.retouch) return;
    this.set({
      retouch: { ...this.state.retouch, shapes: [...this.state.retouch.shapes, shape] },
    });
  };

  readonly undoRetouchShape = (): void => {
    const session = this.state.retouch;
    if (!session || session.shapes.length === 0) return;
    this.set({ retouch: { ...session, shapes: session.shapes.slice(0, -1) } });
  };

  readonly setRetouchFaces = (faces: RetouchFace[]): void => {
    if (!this.state.retouch) return;
    this.set({ retouch: { ...this.state.retouch, faces } });
  };

  readonly toggleRetouchFace = (index: number): void => {
    const session = this.state.retouch;
    const face = session?.faces[index];
    if (!session || !face) return;
    const faces = session.faces.map((candidate, i) =>
      i === index ? { ...candidate, enabled: !candidate.enabled } : candidate,
    );
    this.set({ retouch: { ...session, faces } });
  };

  readonly setRetouchBusy = (busy: boolean): void => {
    if (!this.state.retouch) return;
    this.set({ retouch: { ...this.state.retouch, busy } });
  };

  /** Leave retouch mode without saving. Explicit cancel only; the UI uses {@link requestExitRetouch}. */
  readonly exitRetouch = (): void => {
    if (!this.state.retouch) return;
    this.set({ retouch: undefined });
  };

  /**
   * Leave retouch mode, saving pending shapes/faces first. A failed save keeps
   * the session open so nothing is lost.
   */
  readonly requestExitRetouch = async (): Promise<void> => {
    const session = this.state.retouch;
    if (!session) return;
    if (session.busy || hasPendingRetouch(session)) {
      await this.commitRetouch();
      return;
    }
    this.exitRetouch();
  };

  /**
   * Write the pending shapes (and enabled faces) as one mosaic in a retouch
   * version. Concurrent callers (a Finish during an in-flight commit) share
   * the same promise.
   */
  readonly commitRetouch = (): Promise<Photo | undefined> => {
    if (this.retouchCommit) return this.retouchCommit;
    const run = this.runCommitRetouch();
    this.retouchCommit = run;
    void run.finally(() => {
      if (this.retouchCommit === run) this.retouchCommit = undefined;
    });
    return run;
  };

  private async runCommitRetouch(): Promise<Photo | undefined> {
    const session = this.state.retouch;
    if (!session) return undefined;
    const shapes = [
      ...session.shapes,
      ...session.faces
        .filter((face) => face.enabled)
        .map((face) => padFaceBox(face.box, session.facePadding)),
    ];
    if (shapes.length === 0) {
      this.toast('error', 'Draw a selection or detect a face first');
      return undefined;
    }
    const op: MosaicOp = { type: 'mosaic', shapes, blockSizeRel: session.blockSizeRel };
    this.setRetouchBusy(true);
    try {
      let versionId = session.versionId;
      if (versionId === undefined) {
        const created = await this.bridge.invoke('photos:createVersion', {
          photoId: session.photoId,
          kind: 'retouch',
          name: 'Retouch',
        });
        versionId = created.id;
      }
      await this.bridge.invoke('retouch:set', {
        photoId: session.photoId,
        versionId,
        ops: [op],
      });
      const photo = await this.bridge.invoke('photos:get', { photoId: session.photoId });
      this.upsertPhoto(photo);
      this.exitRetouch();
      this.toast('success', 'Mosaic saved');
      return photo;
    } catch (cause) {
      this.toast('error', `Could not save the retouch: ${messageOf(cause)}`);
      this.setRetouchBusy(false);
      return undefined;
    }
  }

  /** Remove the retouch version the session edits; a version is only created on commit. */
  readonly deleteRetouchVersion = async (): Promise<void> => {
    const session = this.state.retouch;
    if (!session) return;
    if (session.versionId === undefined) {
      this.exitRetouch();
      return;
    }
    this.setRetouchBusy(true);
    try {
      const photo = await this.bridge.invoke('photos:deleteVersion', {
        photoId: session.photoId,
        versionId: session.versionId,
      });
      this.upsertPhoto(photo);
      this.exitRetouch();
      this.toast('success', 'Retouch version deleted');
    } catch (cause) {
      this.toast('error', `Could not delete the version: ${messageOf(cause)}`);
      this.setRetouchBusy(false);
    }
  };

  // -------------------------------------------------------------------- crop

  /** Enter crop mode (C) or apply the current crop when already in it. */
  readonly toggleCrop = (): void => {
    if (this.state.crop) {
      this.applyCrop();
      return;
    }
    if (this.state.retouch) return;
    const photo = activePhoto(this.state);
    if (!photo) return;
    // Crop geometry needs the real oriented image size; disable the mode until
    // the index has it rather than guessing an aspect ratio.
    if (!photo.width || !photo.height || photo.width <= 0 || photo.height <= 0) return;
    const image = { width: photo.width, height: photo.height };
    const params = paramsForPhoto(this.state, photo);
    const existing = params.crop ? sanitizeCrop(params.crop) : undefined;
    const crop = existing
      ? constrainCrop(existing, image)
      : largestCropForAspect(image, 0, image.width / image.height);
    this.set({
      crop: {
        photoId: photo.id,
        image,
        crop,
        aspect: existing ? 'free' : 'original',
        flipped: false,
        tool: 'crop',
      },
    });
  };

  private updateCrop(change: Partial<CropSession>): void {
    if (!this.state.crop) return;
    this.set({ crop: { ...this.state.crop, ...change } });
  }

  readonly setCropTool = (tool: CropSession['tool']): void => {
    this.updateCrop({ tool });
  };

  /** Replace the draft crop (e.g. from a drag); constrained to the image. */
  readonly setCropDraft = (crop: CropParams): void => {
    const session = this.state.crop;
    if (!session) return;
    this.updateCrop({ crop: constrainCrop(sanitizeCrop(crop), session.image) });
  };

  readonly dragCropHandle = (handle: CropHandle, point: { x: number; y: number }): void => {
    const session = this.state.crop;
    if (!session) return;
    const next = resizeCropFromHandle(
      session.crop,
      session.image,
      handle,
      { x: point.x * session.image.width, y: point.y * session.image.height },
      cropAspectRatio(session),
    );
    this.updateCrop({ crop: next });
  };

  readonly setCropAngle = (angle: number): void => {
    const session = this.state.crop;
    if (!session) return;
    const clamped = Math.max(-45, Math.min(45, Number.isFinite(angle) ? angle : 0));
    const geometry = cropGeometry(session.crop, session.image);
    this.updateCrop({
      crop: constrainCrop(
        cropFromGeometry(
          geometry.centerX,
          geometry.centerY,
          geometry.width,
          geometry.height,
          clamped,
          session.image,
        ),
        session.image,
      ),
    });
  };

  readonly setCropAspect = (aspect: CropAspectId): void => {
    const session = this.state.crop;
    if (!session) return;
    if (aspect === 'free') {
      this.updateCrop({ aspect });
      return;
    }
    const base =
      aspect === 'original'
        ? session.image.width / session.image.height
        : CROP_ASPECT_RATIOS[aspect];
    const ratio = session.flipped ? 1 / base : base;
    const geometry = cropGeometry(session.crop, session.image);
    this.updateCrop({
      aspect,
      crop: largestCropForAspect(session.image, geometry.angle, ratio, {
        x: geometry.centerX,
        y: geometry.centerY,
      }),
    });
  };

  /** Swap portrait/landscape for the current aspect preset (X). */
  readonly swapCropOrientation = (): void => {
    const session = this.state.crop;
    if (!session) return;
    if (session.aspect === '1:1') return;
    if (session.aspect === 'free') {
      const geometry = cropGeometry(session.crop, session.image);
      this.updateCrop({
        crop: constrainCrop(
          cropFromGeometry(
            geometry.centerX,
            geometry.centerY,
            geometry.height,
            geometry.width,
            geometry.angle,
            session.image,
          ),
          session.image,
        ),
      });
      return;
    }
    const flipped = !session.flipped;
    const base =
      session.aspect === 'original'
        ? session.image.width / session.image.height
        : CROP_ASPECT_RATIOS[session.aspect];
    const ratio = flipped ? 1 / base : base;
    const geometry = cropGeometry(session.crop, session.image);
    this.updateCrop({
      flipped,
      crop: largestCropForAspect(session.image, geometry.angle, ratio, {
        x: geometry.centerX,
        y: geometry.centerY,
      }),
    });
  };

  readonly resetCrop = (): void => {
    const session = this.state.crop;
    if (!session) return;
    this.updateCrop({
      crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 0 },
      aspect: 'original',
      flipped: false,
    });
  };

  /** Leave crop mode without saving. */
  readonly cancelCrop = (): void => {
    if (!this.state.crop) return;
    this.set({ crop: undefined });
  };

  /** Save the draft crop into the develop parameters (develop:setParams). */
  readonly applyCrop = (): void => {
    const session = this.state.crop;
    if (!session) return;
    const crop = constrainCrop(sanitizeCrop(session.crop), session.image);
    this.patchParams((current) => {
      const next = { ...current };
      if (isFullCrop(crop)) delete next.crop;
      else next.crop = crop;
      return next;
    });
    this.set({ crop: undefined });
  };

  // ----------------------------------------------------------------- metadata

  private async loadMetadata(photoId: PhotoId): Promise<void> {
    const startedAt = this.metadataEditVersion.get(photoId) ?? 0;
    try {
      const fields = await this.bridge.invoke('metadata:read', { photoId });
      // An edit made while the read was in flight is newer than the response.
      const local = this.state.metadata[photoId];
      if ((this.metadataEditVersion.get(photoId) ?? 0) !== startedAt && local) {
        this.set({
          metadata: {
            ...this.state.metadata,
            [photoId]: { ...fields, ...local },
          },
        });
        return;
      }
      this.set({ metadata: { ...this.state.metadata, [photoId]: fields } });
    } catch (cause) {
      this.toast('error', `Could not read metadata: ${messageOf(cause)}`);
    }
  }

  readonly loadTemplate = async (path: string): Promise<void> => {
    try {
      const template = await this.bridge.invoke('metadata:readTemplate', { path });
      this.set({ template, templatePath: path });
    } catch (cause) {
      this.toast('error', `Could not read template: ${messageOf(cause)}`);
    }
  };

  readonly updateMetadataField = (
    photoId: PhotoId,
    field: keyof IptcFields,
    value: IptcFields[keyof IptcFields],
  ): void => {
    const fields = { ...(this.state.metadata[photoId] ?? {}) } as IptcFields;
    (fields as Record<string, unknown>)[field] = value;
    this.metadataEditVersion.set(photoId, (this.metadataEditVersion.get(photoId) ?? 0) + 1);
    this.set({
      metadata: { ...this.state.metadata, [photoId]: fields },
      metadataUnresolved: { ...this.state.metadataUnresolved, [photoId]: [] },
    });
    const pending = this.pendingMetadata.get(photoId) ?? {};
    (pending as Record<string, unknown>)[field] = value;
    this.pendingMetadata.set(photoId, pending);
    this.scheduleMetadataSave(photoId);
  };

  private scheduleMetadataSave(photoId: PhotoId): void {
    const existing = this.metadataTimers.get(photoId);
    if (existing) clearTimeout(existing);
    this.metadataTimers.set(
      photoId,
      setTimeout(() => {
        this.metadataTimers.delete(photoId);
        void this.saveMetadata(photoId);
      }, 500),
    );
  }

  private writeMetadata(photoId: PhotoId, fields: Partial<IptcFields>): Promise<void> {
    const write = this.bridge
      .invoke('metadata:write', { photoId, fields })
      .then((photo) => {
        this.upsertPhoto(photo);
      })
      .catch((cause: unknown) => {
        this.toast('error', `Could not save metadata: ${messageOf(cause)}`);
      })
      .finally(() => {
        if (this.metadataWrites.get(photoId) === write) this.metadataWrites.delete(photoId);
      });
    this.metadataWrites.set(photoId, write);
    return write;
  }

  /** Write every pending field for a photo now, then wait for the bridge. */
  readonly saveMetadata = async (photoId: PhotoId): Promise<void> => {
    const timer = this.metadataTimers.get(photoId);
    if (timer) {
      clearTimeout(timer);
      this.metadataTimers.delete(photoId);
    }
    for (;;) {
      const inFlight = this.metadataWrites.get(photoId);
      if (inFlight) await inFlight;
      const fields = this.pendingMetadata.get(photoId);
      if (!fields) return;
      this.pendingMetadata.delete(photoId);
      await this.writeMetadata(photoId, fields);
      if (!this.pendingMetadata.has(photoId)) return;
    }
  };

  private async flushPendingEdits(): Promise<void> {
    const metadataIds = new Set([
      ...this.pendingMetadata.keys(),
      ...this.metadataWrites.keys(),
      ...this.metadataTimers.keys(),
    ]);
    const developKeys = new Set([...this.developThrottles.keys(), ...this.paramWrites.keys()]);
    await Promise.all([
      ...[...this.labelWrites.values()],
      ...[...metadataIds].map((photoId) => this.saveMetadata(photoId)),
      ...[...developKeys].map((key) => {
        const entry = this.developThrottles.get(key);
        return entry ? this.flushDevelopParams(entry.photoId, entry.versionId) : Promise.resolve();
      }),
    ]);
  }

  readonly expandCaption = async (
    photoId?: PhotoId,
  ): Promise<{ text: string; unresolved: string[] } | undefined> => {
    const id = photoId ?? this.state.selectedId;
    if (!id) return undefined;
    const text = this.state.metadata[id]?.caption ?? '';
    if (!text) return undefined;
    try {
      const result = await this.bridge.invoke('metadata:expandCaption', { photoId: id, text });
      if ((this.state.metadata[id]?.caption ?? '') !== text) return undefined;
      this.updateMetadataField(id, 'caption', result.text);
      this.set({
        metadataUnresolved: { ...this.state.metadataUnresolved, [id]: result.unresolved },
      });
      return result;
    } catch (cause) {
      this.toast('error', `Could not expand caption: ${messageOf(cause)}`);
      return undefined;
    }
  };

  readonly applyTemplate = async (
    mode: TemplateApplyMode = 'replace',
    photoId?: PhotoId,
  ): Promise<void> => {
    const id = photoId ?? this.state.selectedId;
    if (!id) return;
    const path = this.state.settings?.ingest.metadataTemplatePath ?? this.state.templatePath;
    if (!path) {
      this.toast('error', 'No metadata template is configured');
      return;
    }
    try {
      const result = await this.bridge.invoke('metadata:applyTemplate', {
        photoIds: [id],
        templatePath: path,
        mode,
      });
      const [fields, template] = await Promise.all([
        this.bridge.invoke('metadata:read', { photoId: id }),
        this.bridge.invoke('metadata:readTemplate', { path }),
      ]);
      this.set({
        metadata: { ...this.state.metadata, [id]: fields },
        template,
        templatePath: path,
        metadataUnresolved: { ...this.state.metadataUnresolved, [id]: [] },
      });
      if (result.failed.length > 0) {
        this.toast('error', `Template failed for ${result.failed.length} photo(s)`);
      } else {
        this.toast('success', mode === 'replace' ? 'Template applied' : 'Empty fields filled');
      }
    } catch (cause) {
      this.toast('error', `Could not apply template: ${messageOf(cause)}`);
    }
  };

  // ------------------------------------------------------------------ develop

  private async loadParams(photoId: PhotoId): Promise<void> {
    const photo = this.photoById.get(photoId);
    const versionId = activeDevelopVersion(photo)?.id;
    const key = editParamsKey(photoId, versionId);
    const startedAt = this.paramEditVersion.get(key) ?? 0;
    try {
      const params = await this.bridge.invoke('develop:getParams', { photoId, versionId });
      if ((this.paramEditVersion.get(key) ?? 0) !== startedAt && this.state.editParams[key]) {
        return;
      }
      this.set({
        editParams: { ...this.state.editParams, [key]: params },
      });
    } catch (cause) {
      this.toast('error', `Could not read develop settings: ${messageOf(cause)}`);
    }
  }

  private writeDevelop(
    photoId: PhotoId,
    versionId: VersionId | undefined,
    params: EditParams,
  ): Promise<void> {
    const key = editParamsKey(photoId, versionId);
    const sequence = (this.paramSequence.get(key) ?? 0) + 1;
    this.paramSequence.set(key, sequence);
    const write = this.bridge
      .invoke('develop:setParams', { photoId, versionId, params })
      .then(() => undefined)
      .catch((cause: unknown) => {
        // A stale response must not report an error after a newer write won.
        if (this.paramSequence.get(key) === sequence) {
          this.toast('error', `Could not save develop settings: ${messageOf(cause)}`);
        }
      })
      .finally(() => {
        if (this.paramWrites.get(key) === write) this.paramWrites.delete(key);
      });
    this.paramWrites.set(key, write);
    return write;
  }

  private flushDevelopEntry(key: string): void {
    const entry = this.developThrottles.get(key);
    if (!entry) return;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const params = entry.pending;
    entry.pending = undefined;
    if (!params) return;
    entry.lastSentAt = Date.now();
    void this.writeDevelop(entry.photoId, entry.versionId, params);
  }

  private scheduleDevelopSave(
    photoId: PhotoId,
    versionId: VersionId | undefined,
    params: EditParams,
  ): void {
    const key = editParamsKey(photoId, versionId);
    const entry: DevelopThrottle = this.developThrottles.get(key) ?? {
      photoId,
      versionId,
      lastSentAt: 0,
      timer: null,
    };
    entry.photoId = photoId;
    entry.versionId = versionId;
    entry.pending = params;
    this.developThrottles.set(key, entry);

    const elapsed = Date.now() - entry.lastSentAt;
    if (elapsed >= DEVELOP_THROTTLE_MS) {
      this.flushDevelopEntry(key);
    } else if (entry.timer === null) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.flushDevelopEntry(key);
      }, DEVELOP_THROTTLE_MS - elapsed);
    }
  }

  /** Send the latest slider/preset state now and wait for the bridge. */
  readonly flushDevelopParams = async (
    photoId: PhotoId,
    versionId: VersionId | undefined,
  ): Promise<void> => {
    const key = editParamsKey(photoId, versionId);
    if (!this.developThrottles.has(key) && !this.paramWrites.has(key)) return;
    for (;;) {
      const entry = this.developThrottles.get(key);
      if (entry) {
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        const pending = entry.pending;
        entry.pending = undefined;
        if (pending) {
          entry.lastSentAt = Date.now();
          void this.writeDevelop(entry.photoId, entry.versionId, pending);
        }
      }
      const inFlight = this.paramWrites.get(key);
      if (inFlight) await inFlight;
      const current = this.developThrottles.get(key);
      if (!current || (!current.pending && !this.paramWrites.has(key))) return;
    }
  };

  private patchParams(updater: (current: EditParams) => EditParams): void {
    const photo = activePhoto(this.state);
    if (!photo) return;
    const versionId = activeDevelopVersion(photo)?.id;
    const key = editParamsKey(photo.id, versionId);
    const next = updater(this.state.editParams[key] ?? {});
    this.paramEditVersion.set(key, (this.paramEditVersion.get(key) ?? 0) + 1);
    this.set({ editParams: { ...this.state.editParams, [key]: next } });
    this.scheduleDevelopSave(photo.id, versionId, next);
  }

  readonly setSlider = (name: keyof typeof SLIDER_SPECS, rawValue: number | undefined): void => {
    const spec = SLIDER_SPECS[name];
    this.patchParams((current) => {
      const next = { ...current };
      if (rawValue === undefined || (spec.neutral !== null && rawValue === spec.neutral)) {
        delete next[name];
      } else {
        next[name] = Math.max(spec.min, Math.min(spec.max, rawValue));
      }
      return next;
    });
  };

  readonly resetSlider = (name: keyof typeof SLIDER_SPECS): void => {
    this.patchParams((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  readonly setVignetteStyle = (style: EditParams['PostCropVignetteStyle']): void => {
    this.patchParams((current) => {
      const next = { ...current };
      if (style === undefined) delete next.PostCropVignetteStyle;
      else next.PostCropVignetteStyle = style;
      return next;
    });
  };

  readonly applyPreset = (preset: EditPreset): void => {
    const unsupported = unsupportedSettings(preset);
    this.patchParams((current) => mergePreset(current, preset));
    this.set({
      presetNotice:
        unsupported.length > 0
          ? `${unsupported.length} setting${unsupported.length === 1 ? '' : 's'} not supported`
          : undefined,
    });
  };

  readonly importPreset = async (): Promise<void> => {
    try {
      const paths = await this.bridge.invoke('dialog:pick', {
        kind: 'file',
        title: 'Import develop preset',
        extensions: ['xmp'],
      });
      const path = paths[0];
      if (!path) return;
      const preset = await this.bridge.invoke('develop:importPreset', { path });
      const presets = this.state.presets.filter((candidate) => candidate.id !== preset.id);
      const unsupported = unsupportedSettings(preset);
      this.set({
        presets: [...presets, preset],
        presetNotice:
          unsupported.length > 0
            ? `${unsupported.length} setting${unsupported.length === 1 ? '' : 's'} not supported`
            : undefined,
      });
      this.toast('success', `Imported ${preset.name}`);
    } catch (cause) {
      this.toast('error', `Could not import preset: ${messageOf(cause)}`);
    }
  };

  readonly clearPresetNotice = (): void => this.set({ presetNotice: undefined });

  // ------------------------------------------------------------------- upload

  readonly retryUpload = async (uploadId: UploadItem['id']): Promise<void> => {
    try {
      await this.bridge.invoke('upload:retry', { uploadId });
      this.patchUpload(uploadId, (item) => ({
        ...item,
        state: 'queued',
        attempts: item.attempts + 1,
      }));
    } catch (cause) {
      this.toast('error', `Could not retry upload: ${messageOf(cause)}`);
    }
  };

  readonly cancelUpload = async (uploadId: UploadItem['id']): Promise<void> => {
    try {
      await this.bridge.invoke('upload:cancel', { uploadId });
      this.patchUpload(uploadId, (item) => ({ ...item, state: 'cancelled' }));
    } catch (cause) {
      this.toast('error', `Could not cancel upload: ${messageOf(cause)}`);
    }
  };

  private patchUpload(uploadId: UploadItem['id'], updater: (item: UploadItem) => UploadItem): void {
    this.set({
      uploads: this.state.uploads.map((item) => (item.id === uploadId ? updater(item) : item)),
    });
  }

  // ------------------------------------------------------------------- finish

  /** Save a retouch session for this photo before exporting it. */
  private async settleRetouchBeforeFinish(photo: Photo): Promise<void> {
    const session = this.state.retouch;
    if (!session || session.photoId !== photo.id) return;
    if (session.busy || hasPendingRetouch(session)) {
      this.set({ exportProgress: { label: 'Saving retouch…' } });
      const saved = await this.commitRetouch();
      if (!saved) {
        throw new Error('the retouch version could not be saved');
      }
      return;
    }
    this.exitRetouch();
  }

  readonly finishAndNext = async (): Promise<void> => {
    if (this.finishing) return;
    const photo = activePhoto(this.state);
    if (!photo) return;
    const order = this.getVisiblePhotos();
    const exportedIndex = order.findIndex((candidate) => candidate.id === photo.id);
    this.finishing = true;
    try {
      if (this.state.crop?.photoId === photo.id) this.applyCrop();
      await this.settleRetouchBeforeFinish(photo);
      // Re-read after a commit: the captured photo predates the new version.
      const latest = this.photoById.get(photo.id) ?? photo;
      const versionId = activeDevelopVersion(latest)?.id;
      // Export must see the edits that are still inside the UI debounce/throttle.
      await Promise.all([
        this.saveMetadata(latest.id),
        this.flushDevelopParams(latest.id, versionId),
      ]);
      const params = this.state.editParams[editParamsKey(latest.id, versionId)] ?? {};
      this.set({ exportProgress: { label: 'Rendering full resolution…' } });
      const rendered = await this.renderForExport({
        photo: latest,
        params,
        ops: topRetouchVersion(latest)?.ops ?? [],
        onProgress: (progress) => this.set({ exportProgress: progress }),
      });
      this.set({ exportProgress: { label: 'Encoding and uploading…' } });
      const result = await this.bridge.invoke('export:photo', {
        photoId: latest.id,
        versionId,
        rendered,
      });
      if (result.uploads.length > 0) {
        const created = new Set(result.uploads.map((upload) => upload.id));
        this.set({
          uploads: [
            ...this.state.uploads.filter((upload) => !created.has(upload.id)),
            ...result.uploads,
          ],
        });
      }
      // The handler owns the final name; do not reconstruct it from the path.
      const fileName =
        (result as typeof result & { fileName?: string }).fileName ?? latest.fileName;
      this.toast('success', `Exported ${fileName}`);
      const next = exportedIndex >= 0 ? order[exportedIndex + 1] : undefined;
      if (next) this.select(next.id);
    } catch (cause) {
      this.toast('error', `Export failed: ${messageOf(cause)}`);
    } finally {
      this.finishing = false;
      this.set({ exportProgress: undefined });
    }
  };

  readonly dismissToast = (id: number): void => {
    this.set({ toasts: this.state.toasts.filter((toast) => toast.id !== id) });
  };

  // ----------------------------------------------------------------- settings

  readonly saveSource = async (
    source: SourceConfig,
    secret?: CredentialSecret,
  ): Promise<SourceConfig> => {
    let next = source;
    const previousRef =
      next.kind === 'ftp' || next.kind === 'sftp' ? next.credentialRef : undefined;
    let orphanedRef: string | undefined;
    if (secret && (next.kind === 'ftp' || next.kind === 'sftp')) {
      const { ref } = await this.bridge.invoke('credentials:set', {
        secret,
        ref: next.credentialRef,
      });
      if (ref !== previousRef) orphanedRef = ref;
      next = { ...next, credentialRef: ref };
    }
    try {
      const saved = await this.bridge.invoke('sources:save', { source: next });
      const sources = this.state.sources.some((candidate) => candidate.id === saved.id)
        ? this.state.sources.map((candidate) => (candidate.id === saved.id ? saved : candidate))
        : [...this.state.sources, saved];
      this.set({ sources });
      return saved;
    } catch (cause) {
      if (orphanedRef) {
        try {
          await this.bridge.invoke('credentials:remove', { ref: orphanedRef });
        } catch (cleanupCause) {
          this.toast('error', `Could not remove the unused credential: ${messageOf(cleanupCause)}`);
        }
      }
      throw cause;
    }
  };

  readonly removeSource = async (sourceId: SourceId): Promise<void> => {
    const source = this.state.sources.find((candidate) => candidate.id === sourceId);
    await this.bridge.invoke('sources:remove', { sourceId });
    if (source && (source.kind === 'ftp' || source.kind === 'sftp') && source.credentialRef) {
      try {
        await this.bridge.invoke('credentials:remove', { ref: source.credentialRef });
      } catch (cause) {
        this.toast('error', `Could not remove the source credential: ${messageOf(cause)}`);
      }
    }
    this.set({ sources: this.state.sources.filter((candidate) => candidate.id !== sourceId) });
  };

  readonly testSource = async (source: SourceConfig, secret?: CredentialSecret) => {
    let temporaryRef: string | undefined;
    let testTarget = source;
    if (secret && (source.kind === 'ftp' || source.kind === 'sftp')) {
      const { ref } = await this.bridge.invoke('credentials:set', { secret });
      temporaryRef = ref;
      testTarget = { ...source, credentialRef: ref };
    }
    try {
      return await this.bridge.invoke('sources:test', { source: testTarget });
    } finally {
      if (temporaryRef) {
        try {
          await this.bridge.invoke('credentials:remove', { ref: temporaryRef });
        } catch (cause) {
          this.toast('error', `Could not remove the temporary credential: ${messageOf(cause)}`);
        }
      }
    }
  };

  readonly saveDestination = async (
    destination: Destination,
    secret?: CredentialSecret,
  ): Promise<Destination> => {
    let next = destination;
    const previousRef =
      next.kind === 'ftp' || next.kind === 'sftp' ? next.credentialRef : undefined;
    let orphanedRef: string | undefined;
    if (secret && (next.kind === 'ftp' || next.kind === 'sftp')) {
      const { ref } = await this.bridge.invoke('credentials:set', {
        secret,
        ref: next.credentialRef,
      });
      if (ref !== previousRef) orphanedRef = ref;
      next = { ...next, credentialRef: ref };
    }
    try {
      const saved = await this.bridge.invoke('destinations:save', { destination: next });
      const destinations = this.state.destinations.some((candidate) => candidate.id === saved.id)
        ? this.state.destinations.map((candidate) =>
            candidate.id === saved.id ? saved : candidate,
          )
        : [...this.state.destinations, saved];
      this.set({ destinations });
      return saved;
    } catch (cause) {
      if (orphanedRef) {
        try {
          await this.bridge.invoke('credentials:remove', { ref: orphanedRef });
        } catch (cleanupCause) {
          this.toast('error', `Could not remove the unused credential: ${messageOf(cleanupCause)}`);
        }
      }
      throw cause;
    }
  };

  readonly removeDestination = async (destination: Destination['id']): Promise<void> => {
    const removed = this.state.destinations.find((candidate) => candidate.id === destination);
    await this.bridge.invoke('destinations:remove', { destinationId: destination });
    if (removed && (removed.kind === 'ftp' || removed.kind === 'sftp') && removed.credentialRef) {
      try {
        await this.bridge.invoke('credentials:remove', { ref: removed.credentialRef });
      } catch (cause) {
        this.toast('error', `Could not remove the destination credential: ${messageOf(cause)}`);
      }
    }
    this.set({
      destinations: this.state.destinations.filter((item) => item.id !== destination),
    });
  };

  readonly testDestination = async (destination: Destination, secret?: CredentialSecret) => {
    let temporaryRef: string | undefined;
    let testTarget = destination;
    if (secret && (destination.kind === 'ftp' || destination.kind === 'sftp')) {
      const { ref } = await this.bridge.invoke('credentials:set', { secret });
      temporaryRef = ref;
      testTarget = { ...destination, credentialRef: ref };
    }
    try {
      return await this.bridge.invoke('destinations:test', { destination: testTarget });
    } finally {
      if (temporaryRef) {
        try {
          await this.bridge.invoke('credentials:remove', { ref: temporaryRef });
        } catch (cause) {
          this.toast('error', `Could not remove the temporary credential: ${messageOf(cause)}`);
        }
      }
    }
  };

  readonly saveSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    const settings = await this.bridge.invoke('settings:set', patch);
    this.set({ settings });
  };

  readonly startIngest = async (ingest: IngestSettings): Promise<IngestJobInfo[]> => {
    const infos = await this.bridge.invoke('ingest:start', {
      config: { ...ingest, sources: this.state.sources },
    });
    const runs = { ...this.state.ingest };
    for (const info of infos) {
      runs[info.sourceId] = {
        sourceId: info.sourceId,
        jobId: info.jobId,
        state: info.state,
        filesDone: info.filesDone,
        filesTotal: info.filesTotal,
        bytesDone: info.bytesDone,
        error: info.error,
      };
    }
    this.set({ ingest: runs });
    this.toast('success', `Ingest started for ${infos.length} source(s)`);
    return infos;
  };

  // -------------------------------------------------------------------- events

  private handleJobEvent(event: JobEvent): void {
    switch (event.type) {
      case 'ingest.progress': {
        const current = this.state.ingest[event.sourceId];
        this.set({
          ingest: {
            ...this.state.ingest,
            [event.sourceId]: {
              sourceId: event.sourceId,
              jobId: event.jobId,
              state: current?.state ?? 'running',
              filesDone: event.filesDone,
              filesTotal: event.filesTotal,
              bytesDone: event.bytesDone,
              error: current?.error,
            },
          },
        });
        break;
      }
      case 'ingest.state': {
        const current = this.state.ingest[event.sourceId];
        if (!current) break;
        this.set({
          ingest: {
            ...this.state.ingest,
            [event.sourceId]: { ...current, jobId: event.jobId, state: event.state },
          },
        });
        break;
      }
      case 'upload.progress': {
        const item = this.state.uploads.find((candidate) => candidate.id === event.uploadId);
        if (!item) break;
        this.patchUpload(event.uploadId, (candidate) => ({
          ...candidate,
          bytesSent: event.bytesSent,
          bytesTotal: event.bytesTotal,
        }));
        break;
      }
      case 'upload.state': {
        const item = this.state.uploads.find((candidate) => candidate.id === event.uploadId);
        if (item) {
          this.patchUpload(event.uploadId, (candidate) => ({
            ...candidate,
            state: event.state,
            error: event.error,
            bytesSent: event.state === 'done' ? candidate.bytesTotal : candidate.bytesSent,
          }));
        }
        const photo = this.state.photos.find((candidate) => candidate.id === event.photoId);
        if (photo) {
          const upload: Photo['status']['upload'] =
            event.state === 'cancelled' ? 'none' : event.state;
          this.upsertPhoto({
            ...photo,
            status: {
              ...photo.status,
              upload,
              export: event.state === 'done' ? 'done' : photo.status.export,
            },
          });
        }
        break;
      }
      case 'job.error':
        this.toast('error', `${event.scope}: ${event.message}`);
        break;
    }
  }

  // ----------------------------------------------------------------------- ui

  readonly openDialog = (tab: DialogTab): void => this.set({ dialog: tab, shortcutsOpen: false });
  readonly closeDialog = (): void => this.set({ dialog: undefined });
  readonly toggleShortcuts = (open?: boolean): void => {
    this.set({ shortcutsOpen: open ?? !this.state.shortcutsOpen, dialog: undefined });
  };
}

export interface CreateAppStoreOptions {
  /** Replaces the full-resolution renderer in tests. */
  renderForExport?: typeof renderFullResolution;
}

/** Build a store against a bridge; the app uses the preload bridge, tests a fake. */
export function createAppStore(bridge: EeBridge, options: CreateAppStoreOptions = {}): AppStore {
  return new AppStore(bridge, options.renderForExport);
}
