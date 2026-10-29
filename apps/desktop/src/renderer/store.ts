import {
  applyPreset as mergePreset,
  constrainCrop,
  cropFromGeometry,
  cropGeometry,
  cropImageToView,
  cropViewToImage,
  drawCrop,
  isFullCrop,
  largestCropForAspect,
  minCropSize,
  panCrop,
  pointerAngleDelta,
  quantizeAngle,
  resizeCropFromHandle,
  rotateCropInView,
  sanitizeCrop,
  straightenAngleFromLine,
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
  type ExportJob,
  type ExportJobId,
  type ExportPreset,
  type PresetId,
  type IngestJobInfo,
  type IngestSettings,
  type IptcFields,
  type JobEvent,
  type LensShotInfo,
  type Photo,
  type PhotoId,
  type Point,
  type MosaicOp,
  type Rect,
  type Shape,
  type SourceConfig,
  type SourceId,
  type TemplateApplyMode,
  type UploadItem,
  type VersionId,
  retouchOpsKey,
  withDefaults,
} from '@ee/contracts';
import { EditedPreviewScheduler, type EditedPreviewRenderer } from './edited-preview-scheduler';
import { renderFullResolution } from './export-render';
import {
  initialLibrary,
  matchesLibrary,
  mergeFieldEdits,
  type Collection,
  type FieldEdit,
  type LibraryQuick,
  type LibraryState,
} from './library';
import { faceStoredShape, type PhotoLensContext } from './retouch-geometry';

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
export type SelectionMode = 'replace' | 'toggle' | 'range';
/** The four modules of the top bar; Retouch is `AppState.retouch` on the Develop view. */
export type AppModule = 'ingest' | 'library' | 'develop';
export type DialogTab = 'sources' | 'destinations' | 'ingest';

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
  /**
   * `crop`: drag a handle to resize, inside the frame to pan the image, outside
   * it to rotate. `draw`: Lightroom's crop frame tool, drag out a new frame.
   * `straighten`: draw a line along the horizon.
   */
  tool: 'crop' | 'draw' | 'straighten';
  /** Composition guide drawn over the frame while interacting (O cycles). */
  overlay: CropOverlayKind;
  /**
   * Where the frame centre is in view coordinates (source-pixel units; see
   * `cropImageToView`). The frame is axis-aligned on screen and the image is
   * rotated under it, so only this and the crop decide what is drawn where.
   */
  pivot: Point;
  /** The gesture in progress, if any (drives the finer grid while rotating). */
  gesture?: CropGestureRequest['kind'];
  /**
   * The frame size the user asked for. Rotating shrinks the frame to keep the
   * image covering it; this lets it grow back when the angle returns.
   */
  desired?: { width: number; height: number };
}

export const CROP_OVERLAYS = ['thirds', 'grid', 'golden', 'none'] as const;
export type CropOverlayKind = (typeof CROP_OVERLAYS)[number];

export type CropGestureRequest =
  { kind: 'pan' } | { kind: 'rotate' } | { kind: 'draw' } | { kind: 'resize'; handle: CropHandle };

export interface CropModifiers {
  /** Toggles the aspect lock for this drag; Shift also snaps a rotation to 1 degree. */
  shift?: boolean;
  /** Resizes or draws about the centre; Alt on Linux/Windows, Option on macOS. */
  alt?: boolean;
}

interface CropGestureState {
  request: CropGestureRequest;
  start: Point;
  /** How far from the exact handle position the press landed, so the edge does not jump. */
  grab: Point;
  last: Point;
  /** Clockwise degrees the pointer has swept around the pivot so far. */
  swept: number;
  crop: CropParams;
  pivot: Point;
  aspect: number | undefined;
  freeAspect: number | undefined;
  desired: { width: number; height: number };
  /** The session's `desired` before the gesture, restored if it is cancelled. */
  startDesired: { width: number; height: number } | undefined;
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

/** Offset of a handle press from the handle's exact position, on the axes the handle moves. */
function grabOffset(
  request: CropGestureRequest,
  start: Point,
  pivot: Point,
  frame: { width: number; height: number },
): Point {
  if (request.kind !== 'resize') return { x: 0, y: 0 };
  const { handle } = request;
  const x = handle.includes('w')
    ? -frame.width / 2
    : handle.includes('e')
      ? frame.width / 2
      : undefined;
  const y = handle.includes('n')
    ? -frame.height / 2
    : handle.includes('s')
      ? frame.height / 2
      : undefined;
  return {
    x: x === undefined ? 0 : start.x - (pivot.x + x),
    y: y === undefined ? 0 : start.y - (pivot.y + y),
  };
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
  module: AppModule;
  library: LibraryState;
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
  /** What a photo starts with when the sidecar does not say (Lightroom's raw sharpening and colour noise reduction, the camera's `crd:`). Not edits: never written. */
  editDefaults: Record<string, EditParams>;
  /** Lens facts of the photos opened in the develop view (from the linear image header). */
  photoLens: Record<string, PhotoLensContext>;
  /**
   * Values of develop sections that are switched off, by `<photoId>:<section>`. Switching a section
   * off resets its sliders (so the render drops it) and parks the values here; switching it on
   * restores them. In memory only: after a restart the section is simply on with its sliders at neutral.
   */
  sectionStash: Record<string, EditParams>;
  retouch?: RetouchSession;
  crop?: CropSession;
  exportPresets: ExportPreset[];
  exportJobs: ExportJob[];
  exportOpen: boolean;
  selectedId?: PhotoId;
  /** All selected photo ids, in click order; `selectedId` is the active one. */
  selection: PhotoId[];
  /** Anchor for Shift-click ranges. */
  selectionAnchor?: PhotoId;
  filter: FilterState;
  sort: SortMode;
  toasts: Toast[];
  presetNotice?: string;
  dialog?: DialogTab;
  shortcutsOpen: boolean;
  /** The Library's batch caption dialog. */
  batchCaptionOpen: boolean;
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

/** The preset Next & send uses. */
export function activeExportPreset(state: AppState): ExportPreset | undefined {
  const activeId = state.settings?.activePresetId;
  return state.exportPresets.find((preset) => preset.id === activeId) ?? state.exportPresets[0];
}

/** Photos that an export action applies to: the selection, else the active photo. */
export function exportPhotoIds(state: AppState): PhotoId[] {
  if (state.selection.length > 0) return state.selection;
  return state.selectedId ? [state.selectedId] : [];
}

export function exportJobTerminal(job: ExportJob): boolean {
  return job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
}

/** Text for the status bar, e.g. `Exporting 12/40 · Sending 3`. */
export function exportStatusText(state: AppState): string | undefined {
  const job = state.exportJobs.find(
    (candidate) => candidate.state === 'running' || candidate.state === 'queued',
  );
  const sending = state.uploads.filter(
    (upload) => upload.state === 'queued' || upload.state === 'uploading',
  ).length;
  if (!job) return sending > 0 ? `Sending ${sending}` : undefined;
  const done = job.photos.filter(
    (photo) =>
      photo.state === 'done' ||
      photo.state === 'skipped' ||
      photo.state === 'failed' ||
      photo.state === 'cancelled',
  ).length;
  return `Exporting ${done}/${job.photos.length}${sending > 0 ? ` · Sending ${sending}` : ''}`;
}

/** Whether a develop section is on for the photo (see `AppState.sectionStash`). */
export function sectionEnabled(
  state: AppState,
  photo: Photo | undefined,
  section: string,
): boolean {
  return !photo || state.sectionStash[`${photo.id}:${section}`] === undefined;
}

export function photoFlags(state: AppState, photoId: PhotoId): PhotoFlags {
  const photo = state.photos.find((candidate) => candidate.id === photoId);
  return { tagged: photo?.tagged ?? false, colorClass: photo?.colorClass ?? 0 };
}

/** The newest retouch version, which is the one an export applies by default. */
export function topRetouchVersion(photo: Photo | undefined) {
  if (!photo) return undefined;
  for (let i = photo.versions.length - 1; i >= 0; i--) {
    const version = photo.versions[i];
    if (version?.kind === 'retouch') return version;
  }
  return undefined;
}

/** The settings the photo's own sidecar holds (what a save writes). */
export function editedParamsForPhoto(state: AppState, photo: Photo | undefined): EditParams {
  if (!photo) return {};
  return state.editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)] ?? {};
}

/** What the sliders show and what is drawn: the photo's settings over its raw defaults. */
export function paramsForPhoto(state: AppState, photo: Photo | undefined): EditParams {
  if (!photo) return {};
  return withDefaults(editedParamsForPhoto(state, photo), state.editDefaults[photo.id]);
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

function sortPhotos(photos: Photo[], sort: SortMode): Photo[] {
  return photos.sort((left, right) => {
    if (sort === 'capture-time') {
      const byTime = captureTime(left) - captureTime(right);
      if (byTime !== 0) return byTime;
    }
    return naturalName(left, right);
  });
}

/** Photos after the quick/camera/source filters, in the chosen order. */
export function selectVisiblePhotos(state: AppState): Photo[] {
  return sortPhotos(
    state.photos.filter((photo) => {
      if (!matchesQuickFilter(state, photo, state.filter.quick)) return false;
      if (state.filter.camera && cameraKey(photo) !== state.filter.camera) return false;
      if (state.filter.sourceId && photo.sourceId !== state.filter.sourceId) return false;
      return true;
    }),
    state.sort,
  );
}

/** The photos of the Library grid: folder, collection and quick/class filters, in the chosen order. */
export function selectLibraryPhotos(state: AppState): Photo[] {
  return sortPhotos(
    state.photos.filter((photo) => matchesLibrary(photo, state.library)),
    state.sort,
  );
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

const defaultConfirm = (message: string): boolean =>
  typeof window !== 'undefined' && typeof window.confirm === 'function'
    ? window.confirm(message)
    : true;

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
  module: 'develop',
  library: initialLibrary(),
  photos: [],
  sources: [],
  destinations: [],
  presets: [],
  exportPresets: [],
  exportJobs: [],
  exportOpen: false,
  selection: [],
  uploads: [],
  ingest: {},
  metadata: {},
  metadataUnresolved: {},
  editParams: {},
  editDefaults: {},
  photoLens: {},
  sectionStash: {},
  filter: { quick: 'all' },
  sort: 'filename',
  toasts: [],
  shortcutsOpen: false,
  batchCaptionOpen: false,
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
  private readonly editedPreviews: EditedPreviewScheduler | undefined;
  private editedPreviewErrorShown = false;
  private renderChain: Promise<void> = Promise.resolve();
  private readonly exportWaiters = new Map<
    ExportJobId,
    { resolve(): void; reject(error: Error): void }
  >();

  private readonly confirm: (message: string) => boolean;

  constructor(
    private readonly bridge: EeBridge,
    private readonly renderForExport: typeof renderFullResolution = renderFullResolution,
    renderEditedPreview?: EditedPreviewRenderer,
    confirm?: (message: string) => boolean,
  ) {
    this.confirm = confirm ?? defaultConfirm;
    if (renderEditedPreview) {
      this.editedPreviews = new EditedPreviewScheduler({
        // The scheduler works on the photo's own settings (what is saved, and whether it
        // is edited at all); the picture is drawn with the raw defaults under them.
        render: async (photo, params, ops) =>
          renderEditedPreview(photo, withDefaults(params, await this.loadDefaults(photo.id)), ops),
        getPhoto: (photoId) => this.photoById.get(photoId),
        settle: (photoId) =>
          this.flushDevelopParams(photoId, activeDevelopVersion(this.photoById.get(photoId))?.id),
        getParams: (photoId) => this.currentParams(photoId),
        getRetouchOps: (photo) => topRetouchVersion(photo)?.ops ?? [],
        store: (args) => this.bridge.invoke('photos:setEditedPreview', args),
        // Without waiting for the photos:updated event, so a photo is not drawn twice.
        onStored: (photo) => this.upsertPhoto(photo),
        // The backend still calls it stale (say, a sidecar with only a process version).
        onNoEdits: (photo) =>
          this.upsertPhoto({ ...(this.photoById.get(photo.id) ?? photo), previewStale: false }),
        onError: (photo, cause) => {
          console.warn(`Could not render the thumbnail of ${photo.fileName}`, cause);
          // One toast per session: a missing GPU would otherwise fail photo after photo.
          if (this.editedPreviewErrorShown) return;
          this.editedPreviewErrorShown = true;
          this.toast('error', `Could not update thumbnails: ${messageOf(cause)}`);
        },
      });
    }
  }

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

  private readonly notified = new Set<string>();

  /** Like {@link notify}, but only the first time for `key` in this session. */
  readonly notifyOnce = (key: string, kind: Toast['kind'], message: string): void => {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    this.toast(kind, message);
  };

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
    // Restored jobs wait for this before asking for their next render.
    await this.bridge.invoke('export:rendererReady').catch(() => undefined);
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
    this.editedPreviews?.dispose();
    this.cancelPhotoFlush();
    this.flushQueuedPhotos();
    await this.flushPendingEdits();
  };

  private async loadAll(): Promise<void> {
    const [
      photos,
      sources,
      destinations,
      settings,
      presets,
      uploads,
      ingest,
      exportPresets,
      exportJobs,
    ] = await Promise.allSettled([
      this.bridge.invoke('photos:list'),
      this.bridge.invoke('sources:list'),
      this.bridge.invoke('destinations:list'),
      this.bridge.invoke('settings:get'),
      this.bridge.invoke('develop:listPresets'),
      this.bridge.invoke('upload:list'),
      this.bridge.invoke('ingest:status'),
      this.bridge.invoke('exportPresets:list'),
      this.bridge.invoke('export:list'),
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
      exportPresets: value(exportPresets) ?? [],
      exportJobs: value(exportJobs) ?? [],
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

  /** The order Shift-click ranges follow: the grid's in the Library, the film strip's elsewhere. */
  private selectionOrder(): Photo[] {
    return this.state.module === 'library' ? this.getLibraryPhotos() : this.getVisiblePhotos();
  }

  private applySelection(photoId: PhotoId | undefined, mode: SelectionMode = 'replace'): void {
    if (
      photoId === this.state.selectedId &&
      mode === 'replace' &&
      this.state.selection.length <= 1
    ) {
      return;
    }
    // Leaving a photo with an edit still settling: render it now, not when it is forgotten.
    if (this.state.selectedId) this.editedPreviews?.promote(this.state.selectedId);
    if (!photoId) {
      this.set({ selectedId: undefined, selection: [], selectionAnchor: undefined });
      this.editedPreviews?.setSelected(undefined);
      return;
    }

    let selection: PhotoId[];
    let anchor = this.state.selectionAnchor ?? this.state.selectedId ?? photoId;
    if (mode === 'toggle') {
      selection = this.state.selection.includes(photoId)
        ? this.state.selection.filter((id) => id !== photoId)
        : [...this.state.selection, photoId];
      if (selection.length === 0) anchor = photoId;
    } else if (mode === 'range') {
      const order = this.selectionOrder().map((photo) => photo.id);
      const from = order.indexOf(anchor);
      const to = order.indexOf(photoId);
      selection =
        from < 0 || to < 0 ? [photoId] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
    } else {
      selection = [photoId];
      anchor = photoId;
    }

    const selectedId =
      mode === 'toggle' && !selection.includes(photoId) ? selection.at(-1) : photoId;
    this.set({ selectedId, selection, selectionAnchor: anchor });
    if (!selectedId) {
      this.editedPreviews?.setSelected(undefined);
      return;
    }
    void this.loadMetadata(selectedId);
    void this.loadParams(selectedId);
    this.editedPreviews?.setSelected(selectedId);
  }

  /**
   * The frames the film strip shows now: draw the edited thumbnails of those that
   * never got one, and stop working on photos that scrolled out of view.
   */
  readonly setVisibleEditedPreviews = (photoIds: readonly PhotoId[]): void => {
    this.editedPreviews?.setVisible(photoIds);
  };

  readonly select = (photoId: PhotoId | undefined, mode: SelectionMode = 'replace'): void => {
    if (
      photoId === this.state.selectedId &&
      mode === 'replace' &&
      this.state.selection.length <= 1
    ) {
      return;
    }
    if (this.state.crop && this.state.crop.photoId !== photoId) this.applyCrop();
    const session = this.state.retouch;
    if (session && session.photoId !== photoId) {
      // Never lose an unreviewed mosaic by navigating away. The commit path is
      // shared with exports, so an in-flight save is awaited instead of duplicated.
      if (session.busy || hasPendingRetouch(session)) {
        void this.commitRetouch().then((photo) => {
          if (photo) this.applySelection(photoId, mode);
        });
        return;
      }
      this.exitRetouch();
    }
    this.applySelection(photoId, mode);
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
    const visibleIds = new Set(visible.map((photo) => photo.id));
    if (visible.some((photo) => photo.id === this.state.selectedId)) {
      const selection = this.state.selection.filter((id) => visibleIds.has(id));
      if (selection.length !== this.state.selection.length) this.set({ selection });
      return;
    }
    const next = visible[0];
    if (next) this.select(next.id);
    else this.set({ selectedId: undefined, selection: [], selectionAnchor: undefined });
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
    const previous = Promise.all(
      photoIds.map((id) => this.labelWrites.get(id) ?? Promise.resolve()),
    );
    // One IPC call for the whole batch, queued behind any earlier write to the same photos.
    const write: Promise<void> = previous
      .then(() => this.bridge.invoke('photos:setLabels', { photoIds, ...patch }))
      .then((photos) => {
        for (const photo of photos) this.upsertPhoto(photo);
      })
      .catch((cause: unknown) => {
        this.toast('error', `Could not save labels: ${messageOf(cause)}`);
      })
      .finally(() => {
        for (const id of photoIds)
          if (this.labelWrites.get(id) === write) this.labelWrites.delete(id);
      });
    for (const id of photoIds) this.labelWrites.set(id, write);
  }

  /** Photos a label shortcut applies to: the Library selection there, otherwise the open photo. */
  private labelTargets(photoId?: PhotoId): PhotoId[] {
    if (photoId) return [photoId];
    const { module, selection, selectedId } = this.state;
    if (module === 'library' && selection.length > 0) return [...selection];
    return selectedId ? [selectedId] : [];
  }

  /** Tags every target; if all are tagged already, untags them (Photo Mechanic's behaviour). */
  readonly toggleTag = (photoId?: PhotoId): void => {
    const ids = this.labelTargets(photoId).filter((id) => this.photoById.has(id));
    if (ids.length === 0) return;
    const tagged = !ids.every((id) => this.photoById.get(id)?.tagged);
    this.applyLabelPatch(ids, { tagged });
    this.persistLabels(ids, { tagged });
    if (this.state.module !== 'library') this.ensureSelectionVisible();
  };

  readonly setColorClass = (colorClass: number, photoId?: PhotoId): void => {
    if (!Number.isInteger(colorClass) || colorClass < 0 || colorClass > 8) return;
    const ids = this.labelTargets(photoId).filter((id) => this.photoById.has(id));
    if (ids.length === 0) return;
    this.applyLabelPatch(ids, { colorClass });
    this.persistLabels(ids, { colorClass });
  };

  // ------------------------------------------------------------------ modules

  /**
   * Switch module. Leaving Develop settles the open crop and retouch session first, as
   * selecting another photo does.
   */
  readonly setModule = (module: AppModule): void => {
    if (module === this.state.module) return;
    if (this.state.module === 'develop') {
      if (this.state.crop) this.applyCrop();
      if (this.state.retouch) void this.requestExitRetouch();
    }
    this.set({ module });
    if (module === 'develop' && !this.state.selectedId) {
      const first = this.getVisiblePhotos()[0];
      if (first) this.select(first.id);
    }
  };

  /** Retouch module: Develop with the retouch session open on the selected photo. */
  readonly openRetouchModule = (): void => {
    this.setModule('develop');
    if (!this.state.retouch) this.toggleRetouch();
  };

  // ------------------------------------------------------------------ library

  private setLibrary(patch: Partial<LibraryState>): void {
    this.set({ library: { ...this.state.library, ...patch } });
  }

  private libraryColumns = 1;

  /** The grid reports its column count so Up and Down move by a row. */
  readonly setLibraryColumns = (columns: number): void => {
    this.libraryColumns = Math.max(1, columns);
  };

  /** Up/Down in the grid. */
  readonly moveRowInLibrary = (rows: number, extend = false): void =>
    this.moveInLibrary(rows * this.libraryColumns, extend);

  readonly getLibraryPhotos = (): Photo[] => selectLibraryPhotos(this.state);

  readonly setLibraryFolder = (folder: string | undefined): void => {
    this.setLibrary({ folder, collection: undefined });
  };

  readonly setLibraryCollection = (collection: Collection | undefined): void => {
    this.setLibrary({ collection, folder: undefined });
  };

  readonly setLibraryQuick = (quick: LibraryQuick): void => this.setLibrary({ quick });

  readonly setLibraryColorFilter = (colorClass: number | undefined): void =>
    this.setLibrary({ colorClass });

  readonly setThumbSize = (thumbSize: number): void => this.setLibrary({ thumbSize });

  /** G (grid) and E (loupe) both live in the Library module. */
  readonly openLibrary = (view: LibraryState['view'] = 'grid'): void => {
    if (view === 'loupe' && !this.state.selectedId) return;
    this.setModule('library');
    this.setLibrary({ view });
  };

  /** Every photo in the grid becomes selected (Ctrl/Cmd+A); the open photo stays open. */
  readonly selectAllInLibrary = (): void => {
    const ids = this.getLibraryPhotos().map((photo) => photo.id);
    this.set({ selection: ids, selectionAnchor: this.state.selectionAnchor ?? ids[0] });
  };

  /** Esc: back to just the open photo. */
  readonly clearLibrarySelection = (): void => {
    const { selectedId } = this.state;
    this.set({ selection: selectedId ? [selectedId] : [], selectionAnchor: selectedId });
  };

  /** Arrow keys in the grid; `extend` grows the selection like Shift-click. */
  readonly moveInLibrary = (delta: number, extend = false): void => {
    const photos = this.getLibraryPhotos();
    if (photos.length === 0) return;
    const index = photos.findIndex((photo) => photo.id === this.state.selectedId);
    const next = photos[Math.max(0, Math.min(photos.length - 1, (index < 0 ? 0 : index) + delta))];
    if (next) this.select(next.id, extend ? 'range' : 'replace');
  };

  /**
   * Write caption/IPTC edits to every photo in `photoIds`. Append needs each photo's current
   * value, so the fields are read fresh from the sidecar; pending typing is saved first.
   * Resolves with the number of photos written.
   */
  readonly applyFieldEdits = async (
    photoIds: readonly PhotoId[],
    edits: readonly FieldEdit[],
  ): Promise<number> => {
    if (photoIds.length === 0 || edits.length === 0) return 0;
    let written = 0;
    const failed: string[] = [];
    for (const photoId of photoIds) {
      try {
        await this.saveMetadata(photoId);
        const current = await this.bridge.invoke('metadata:read', { photoId });
        // Expand `=codes=` and `{variables}` of the caption per photo, as typing it would.
        const resolved = await Promise.all(
          edits.map(async (edit) => {
            if (edit.field !== 'caption' || typeof edit.value !== 'string') return edit;
            if (!/[={]/.test(edit.value)) return edit;
            const expanded = await this.bridge.invoke('metadata:expandCaption', {
              photoId,
              text: edit.value,
            });
            return { ...edit, value: expanded.text };
          }),
        );
        const fields = mergeFieldEdits(current, resolved);
        const photo = await this.bridge.invoke('metadata:write', { photoId, fields });
        this.upsertPhoto(photo);
        this.set({ metadata: { ...this.state.metadata, [photoId]: { ...current, ...fields } } });
        written += 1;
      } catch (cause) {
        failed.push(`${this.photoById.get(photoId)?.fileName ?? photoId}: ${messageOf(cause)}`);
      }
    }
    if (failed.length > 0) {
      this.toast('error', `Could not caption ${failed.length} photo(s): ${failed[0]}`);
    }
    if (written > 0) this.toast('success', `Captioned ${written} photo${written === 1 ? '' : 's'}`);
    return written;
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
        .map((face) =>
          faceStoredShape(face.box, session.facePadding, this.state.photoLens[session.photoId]),
        ),
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
      // Ahead of the debounce: until the mosaicked images exist, the film strip shows a placeholder.
      this.editedPreviews?.scheduleNow(photo.id);
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
      this.editedPreviews?.scheduleNow(photo.id);
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
    const geometry = cropGeometry(crop, image);
    this.cropGesture = undefined;
    this.set({
      crop: {
        photoId: photo.id,
        image,
        crop,
        aspect: existing ? 'free' : 'original',
        flipped: false,
        tool: 'crop',
        overlay: 'thirds',
        pivot: { x: geometry.centerX, y: geometry.centerY },
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

  /** Switch a tool on, or back to the normal crop tool when it is already on. */
  readonly toggleCropTool = (tool: Exclude<CropSession['tool'], 'crop'>): void => {
    const session = this.state.crop;
    if (!session) return;
    this.updateCrop({ tool: session.tool === tool ? 'crop' : tool });
  };

  /** O: thirds, grid, golden ratio, none. */
  readonly cycleCropOverlay = (): void => {
    const session = this.state.crop;
    if (!session) return;
    const next = CROP_OVERLAYS[(CROP_OVERLAYS.indexOf(session.overlay) + 1) % CROP_OVERLAYS.length];
    this.updateCrop({ overlay: next ?? 'thirds' });
  };

  // Gestures work from a snapshot taken when the pointer went down, so every
  // update is a pure function of (snapshot, pointer, modifiers): Shift or Alt
  // can change mid-drag, and the frame never drifts from rounding.
  private cropGesture?: CropGestureState;

  /**
   * Starts a pan, rotate, resize or draw on the crop frame. `start` is the
   * pointer in view coordinates (source-pixel units, see `cropImageToView`).
   */
  readonly beginCropGesture = (request: CropGestureRequest, start: Point): void => {
    const session = this.state.crop;
    if (!session) return;
    const geometry = cropGeometry(session.crop, session.image);
    this.cropGesture = {
      request,
      start,
      last: start,
      swept: 0,
      crop: session.crop,
      pivot: session.pivot,
      grab: grabOffset(request, start, session.pivot, geometry),
      aspect: cropAspectRatio(session),
      freeAspect: geometry.height > 0 ? geometry.width / geometry.height : undefined,
      desired: session.desired ?? { width: geometry.width, height: geometry.height },
      startDesired: session.desired,
    };
    this.updateCrop({ gesture: request.kind });
  };

  readonly updateCropGesture = (point: Point, modifiers: CropModifiers = {}): void => {
    const session = this.state.crop;
    const gesture = this.cropGesture;
    if (!session || !gesture) return;
    const { image } = session;
    const symmetric = modifiers.alt === true;
    // Shift flips the preset lock: a locked preset goes free, Free locks to the
    // frame the drag started from.
    const aspect = modifiers.shift
      ? gesture.aspect === undefined
        ? gesture.freeAspect
        : undefined
      : gesture.aspect;
    switch (gesture.request.kind) {
      case 'pan': {
        const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
        this.updateCrop({ crop: panCrop(gesture.crop, image, delta) });
        break;
      }
      case 'rotate': {
        gesture.swept += pointerAngleDelta(gesture.pivot, gesture.last, point);
        gesture.last = point;
        // The image turns with the pointer, i.e. against the crop angle.
        const angle = quantizeAngle(gesture.crop.angle - gesture.swept, modifiers.shift === true);
        this.updateCrop({
          ...rotateCropInView(gesture.crop, image, gesture.pivot, angle, gesture.desired),
          desired: gesture.desired,
        });
        break;
      }
      case 'resize': {
        const start = cropGeometry(gesture.crop, image);
        const target = cropViewToImage(start, gesture.pivot, {
          x: point.x - gesture.grab.x,
          y: point.y - gesture.grab.y,
        });
        const crop = resizeCropFromHandle(
          gesture.crop,
          image,
          gesture.request.handle,
          target,
          aspect,
          symmetric,
        );
        // The image stays where it is on screen, so the frame centre moves with the edges.
        const next = cropGeometry(crop, image);
        this.updateCrop({
          crop,
          pivot: cropImageToView(start, gesture.pivot, { x: next.centerX, y: next.centerY }),
          desired: undefined,
        });
        break;
      }
      case 'draw': {
        const moved = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
        if (moved < minCropSize(image)) break;
        const drawn = drawCrop(
          gesture.crop,
          image,
          gesture.pivot,
          gesture.start,
          point,
          aspect,
          symmetric,
        );
        if (drawn) this.updateCrop({ ...drawn, desired: undefined });
        break;
      }
    }
  };

  readonly endCropGesture = (): void => {
    const gesture = this.cropGesture;
    this.cropGesture = undefined;
    const session = this.state.crop;
    if (!gesture || !session) return;
    // The frame tool draws one frame, then hands back to the normal crop tool.
    this.updateCrop({
      gesture: undefined,
      tool: gesture.request.kind === 'draw' ? 'crop' : session.tool,
    });
  };

  /**
   * The pointer was cancelled or lost mid-drag: put the frame back as it was
   * before the gesture. Unlike {@link endCropGesture} this keeps the tool, so a
   * cancelled draw does not silently hand back to the crop tool.
   */
  readonly cancelCropGesture = (): void => {
    const gesture = this.cropGesture;
    this.cropGesture = undefined;
    if (!gesture || !this.state.crop) return;
    this.updateCrop({
      crop: gesture.crop,
      pivot: gesture.pivot,
      desired: gesture.startDesired,
      gesture: undefined,
    });
  };

  /**
   * Straighten tool: a line drawn along the horizon, in view coordinates.
   * Ignores accidental short lines.
   */
  readonly straightenAlongLine = (from: Point, to: Point): void => {
    const session = this.state.crop;
    if (!session) return;
    if (Math.hypot(to.x - from.x, to.y - from.y) >= minCropSize(session.image)) {
      this.setCropAngle(straightenAngleFromLine(session.crop.angle, from, to));
    }
    this.updateCrop({ tool: 'crop' });
  };

  /** Slider and typed angle: the image turns about the frame centre. */
  /** Replaces the draft crop (programmatic edits); constrained to the image, frame centred. */
  readonly setCropDraft = (crop: CropParams): void => {
    const session = this.state.crop;
    if (!session) return;
    const next = constrainCrop(sanitizeCrop(crop), session.image);
    const geometry = cropGeometry(next, session.image);
    this.updateCrop({
      crop: next,
      pivot: { x: geometry.centerX, y: geometry.centerY },
      desired: undefined,
    });
  };

  readonly setCropAngle = (angle: number): void => {
    const session = this.state.crop;
    if (!session) return;
    const geometry = cropGeometry(session.crop, session.image);
    const desired = session.desired ?? { width: geometry.width, height: geometry.height };
    this.updateCrop({
      ...rotateCropInView(session.crop, session.image, session.pivot, angle, desired),
      desired,
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
      desired: undefined,
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
        desired: undefined,
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
      desired: undefined,
      crop: largestCropForAspect(session.image, geometry.angle, ratio, {
        x: geometry.centerX,
        y: geometry.centerY,
      }),
    });
  };

  readonly resetCrop = (): void => {
    const session = this.state.crop;
    if (!session) return;
    this.cropGesture = undefined;
    this.updateCrop({
      crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 0 },
      pivot: { x: session.image.width / 2, y: session.image.height / 2 },
      aspect: 'original',
      flipped: false,
      tool: 'crop',
      gesture: undefined,
      desired: undefined,
    });
  };

  /** Leave crop mode without saving. */
  readonly cancelCrop = (): void => {
    if (!this.state.crop) return;
    this.cropGesture = undefined;
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
    this.cropGesture = undefined;
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
      const [params, defaults] = await Promise.all([
        this.bridge.invoke('develop:getParams', { photoId, versionId }),
        this.loadDefaults(photoId),
      ]);
      if ((this.paramEditVersion.get(key) ?? 0) !== startedAt && this.state.editParams[key]) {
        return;
      }
      this.set({
        editParams: { ...this.state.editParams, [key]: params },
        editDefaults: { ...this.state.editDefaults, [photoId]: defaults },
      });
    } catch (cause) {
      this.toast('error', `Could not read develop settings: ${messageOf(cause)}`);
    }
  }

  /** The raw defaults of a photo, read once. A failure leaves the photo without defaults, with a notice. */
  private async loadDefaults(photoId: PhotoId): Promise<EditParams> {
    const known = this.state.editDefaults[photoId];
    if (known) return known;
    try {
      return await this.bridge.invoke('develop:getDefaults', { photoId });
    } catch (cause) {
      this.toast('error', `Could not read the camera's default settings: ${messageOf(cause)}`);
      return {};
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
    this.editedPreviews?.schedule(photo.id);
  }

  /** The develop params of any photo as saved or edited (without raw defaults), including edits that have not reached the sidecar yet. */
  private async currentParams(photoId: PhotoId): Promise<EditParams> {
    const versionId = activeDevelopVersion(this.photoById.get(photoId))?.id;
    return (
      this.state.editParams[editParamsKey(photoId, versionId)] ??
      this.bridge.invoke('develop:getParams', { photoId, versionId })
    );
  }

  readonly setSlider = (name: keyof typeof SLIDER_SPECS, rawValue: number | undefined): void => {
    const spec = SLIDER_SPECS[name];
    const photo = activePhoto(this.state);
    // The value the slider starts at: the raw default where the photo has one, else neutral.
    // Sitting on it means "not touched" (key removed); anything else, 0 included, is written.
    const start = (photo && this.state.editDefaults[photo.id]?.[name]) ?? spec.neutral;
    this.patchParams((current) => {
      const next = { ...current };
      if (rawValue === undefined || (start !== null && rawValue === start)) {
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

  /** Switch a develop section off (parking its values) or back on (restoring them). */
  readonly setSectionEnabled = (
    section: string,
    params: readonly (keyof typeof SLIDER_SPECS)[],
    enabled: boolean,
  ): void => {
    const photo = activePhoto(this.state);
    if (!photo) return;
    const key = `${photo.id}:${section}`;
    const stash = { ...this.state.sectionStash };
    if (enabled) {
      const parked = stash[key];
      delete stash[key];
      this.set({ sectionStash: stash });
      this.patchParams((current) => {
        const next = { ...current };
        for (const name of params) delete next[name];
        return { ...next, ...parked };
      });
      return;
    }
    // Park only what the user set; raw defaults come back by themselves when the key is gone.
    const current = editedParamsForPhoto(this.state, photo);
    const defaults = this.state.editDefaults[photo.id] ?? {};
    const parked: EditParams = {};
    for (const name of params) {
      const value = current[name];
      if (value !== undefined) Object.assign(parked, { [name]: value });
    }
    stash[key] = parked;
    this.set({ sectionStash: stash });
    this.patchParams((existing) => {
      const next = { ...existing };
      for (const name of params) {
        delete next[name];
        // A raw default (say, sharpening 40) would come back, so "off" writes the neutral value.
        const neutral = SLIDER_SPECS[name].neutral;
        if (defaults[name] !== undefined && neutral !== null)
          Object.assign(next, { [name]: neutral });
      }
      return next;
    });
  };

  /** Remembers the lens facts of a photo for the Lens Corrections panel. */
  readonly setPhotoLens = (
    photoId: PhotoId,
    lens: LensShotInfo | undefined,
    size: { width: number; height: number },
  ): void => {
    const known = this.state.photoLens[photoId];
    const context: PhotoLensContext = { lens, width: size.width, height: size.height };
    if (JSON.stringify(context) === JSON.stringify(known)) return;
    this.set({ photoLens: { ...this.state.photoLens, [photoId]: context } });
  };

  /** The Lens Corrections switches: stored explicitly, so a lens the camera requires can be turned off. */
  readonly setLensFlag = (name: 'LensProfileEnable' | 'AutoLateralCA', value: boolean): void => {
    this.patchParams((current) => ({ ...current, [name]: value }));
  };

  /** The profile select: `''` is automatic. */
  readonly setLensProfileChoice = (value: string): void => {
    this.patchParams((current) => {
      const next = { ...current };
      if (value === '') delete next.LensProfileChoice;
      else next.LensProfileChoice = value;
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

  // ------------------------------------------------------------------ exports

  /** Save retouch/crop drafts and debounced edits before an export reads them. */
  private async settleBeforeExport(photoIds: readonly PhotoId[]): Promise<void> {
    const ids = new Set(photoIds);
    if (this.state.crop && ids.has(this.state.crop.photoId)) this.applyCrop();
    const session = this.state.retouch;
    if (session && ids.has(session.photoId)) {
      if (session.busy || hasPendingRetouch(session)) {
        const saved = await this.commitRetouch();
        if (!saved) throw new Error('the retouch version could not be saved');
      } else {
        this.exitRetouch();
      }
    }
    await this.flushPendingEdits();
  }

  private orderedPhotoIds(photoIds: readonly PhotoId[]): PhotoId[] {
    const order = new Map(this.getVisiblePhotos().map((photo, index) => [photo.id, index]));
    return [...new Set(photoIds)].sort(
      (left, right) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  private exportJob(jobId: ExportJobId): ExportJob | undefined {
    return this.state.exportJobs.find((job) => job.id === jobId);
  }

  private settleExportJob(job: ExportJob): void {
    if (job.state === 'failed') {
      const failed = job.photos.filter((photo) => photo.state === 'failed');
      const detail = failed.find((photo) => photo.error !== undefined)?.error;
      throw new Error(detail ?? `${failed.length} photo(s) could not be exported`);
    }
    if (job.state === 'cancelled') throw new Error('the export was cancelled');
  }

  private notifyExportWaiter(job: ExportJob): void {
    if (!exportJobTerminal(job)) return;
    const waiter = this.exportWaiters.get(job.id);
    if (!waiter) return;
    this.exportWaiters.delete(job.id);
    waiter.resolve();
  }

  private async refreshExportJobs(): Promise<ExportJob[]> {
    const jobs = await this.bridge.invoke('export:list');
    this.set({ exportJobs: jobs });
    for (const job of jobs) this.notifyExportWaiter(job);
    return jobs;
  }

  private waitForExportJob(jobId: ExportJobId): Promise<void> {
    const existing = this.exportJob(jobId);
    if (existing && exportJobTerminal(existing)) {
      try {
        this.settleExportJob(existing);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<void>((resolve, reject) => {
      this.exportWaiters.set(jobId, {
        resolve: () => {
          const job = this.exportJob(jobId);
          try {
            if (job) this.settleExportJob(job);
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        reject,
      });
      // A job can finish between the invoke returning and this registration.
      const after = this.exportJob(jobId);
      if (after && exportJobTerminal(after)) {
        const waiter = this.exportWaiters.get(jobId);
        this.exportWaiters.delete(jobId);
        waiter?.resolve();
      }
    });
  }

  private async runExport(options: {
    photoIds?: readonly PhotoId[];
    presetId?: PresetId;
    send: boolean;
    wait?: boolean;
  }): Promise<ExportJobId | undefined> {
    const photoIds = this.orderedPhotoIds(options.photoIds ?? exportPhotoIds(this.state));
    if (photoIds.length === 0) {
      this.toast('error', 'Select at least one photo to export');
      return undefined;
    }
    const presetId = options.presetId ?? activeExportPreset(this.state)?.id;
    const preset = this.state.exportPresets.find((candidate) => candidate.id === presetId);
    if (!presetId || !preset) {
      this.toast('error', 'No export preset is configured');
      return undefined;
    }
    if (!options.send && preset.version === 'develop') {
      const retouched = photoIds.filter(
        (photoId) => topRetouchVersion(this.photoById.get(photoId)) !== undefined,
      ).length;
      if (
        retouched > 0 &&
        !this.confirm(
          `${retouched} photo${retouched === 1 ? ' has' : 's have'} a retouch version; ` +
            'export without mosaic?',
        )
      ) {
        return undefined;
      }
    }
    try {
      await this.settleBeforeExport(photoIds);
      const jobId = await this.bridge.invoke('export:start', {
        photoIds,
        presetId,
        ...(options.send ? { forceTop: true } : { send: [] }),
      });
      await this.refreshExportJobs();
      if (options.wait) await this.waitForExportJob(jobId);
      return jobId;
    } catch (cause) {
      this.toast('error', `Export failed: ${messageOf(cause)}`);
      return undefined;
    }
  }

  /** Fill an export job's render request from what the user currently sees. */
  private async performExportRender(
    request: Extract<JobEvent, { type: 'export.render' }>,
  ): Promise<void> {
    try {
      const photo = this.photoById.get(request.photoId);
      if (!photo) throw new Error(`no photo ${request.photoId}`);
      await this.settleBeforeExport([photo.id]);
      // Re-read after a retouch commit: the captured photo predates the new version.
      const latest = this.photoById.get(photo.id) ?? photo;
      const versionId = activeDevelopVersion(latest)?.id;
      await Promise.all([
        this.saveMetadata(latest.id),
        this.flushDevelopParams(latest.id, versionId),
      ]);
      const params = withDefaults(
        this.state.editParams[editParamsKey(latest.id, versionId)] ?? {},
        await this.loadDefaults(latest.id),
      );
      const ops = request.version === 'top' ? (topRetouchVersion(latest)?.ops ?? []) : [];
      const rendered = await this.renderForExport({ photo: latest, params, ops });
      await this.bridge.invoke('export:render', {
        jobId: request.jobId,
        requestId: request.requestId,
        rendered,
        opsKey: retouchOpsKey(ops),
      });
    } catch (cause) {
      await this.bridge
        .invoke('export:render', {
          jobId: request.jobId,
          requestId: request.requestId,
          error: messageOf(cause),
        })
        .catch(() => undefined);
    }
  }

  /** Queue the current selection (or the active photo) for a background export. */
  readonly exportSelected = async (send: boolean, presetId?: PresetId): Promise<void> => {
    await this.runExport({ send, presetId });
  };

  /** Export the active photo with the active preset, then advance to the next one. */
  readonly nextAndSend = async (): Promise<void> => {
    if (this.finishing) return;
    const photo = activePhoto(this.state);
    if (!photo) return;
    const order = this.getVisiblePhotos();
    const exportedIndex = order.findIndex((candidate) => candidate.id === photo.id);
    this.finishing = true;
    try {
      const jobId = await this.runExport({ photoIds: [photo.id], send: true, wait: true });
      if (jobId === undefined) return;
      const next = exportedIndex >= 0 ? order[exportedIndex + 1] : undefined;
      if (next) this.select(next.id);
    } finally {
      this.finishing = false;
    }
  };

  readonly openExportDialog = (): void => this.set({ exportOpen: true, dialog: undefined });
  readonly closeExportDialog = (): void => this.set({ exportOpen: false });

  readonly saveExportPreset = async (preset: ExportPreset): Promise<void> => {
    const saved = await this.bridge.invoke('exportPresets:save', { preset });
    const presets = this.state.exportPresets.some((candidate) => candidate.id === saved.id)
      ? this.state.exportPresets.map((candidate) => (candidate.id === saved.id ? saved : candidate))
      : [...this.state.exportPresets, saved];
    this.set({ exportPresets: presets });
  };

  readonly removeExportPreset = async (presetId: PresetId): Promise<void> => {
    await this.bridge.invoke('exportPresets:remove', { presetId });
    const [presets, settings] = await Promise.all([
      this.bridge.invoke('exportPresets:list'),
      this.bridge.invoke('settings:get'),
    ]);
    this.set({ exportPresets: presets, settings });
  };

  readonly setActivePreset = async (presetId: PresetId): Promise<void> => {
    const settings = await this.bridge.invoke('settings:set', { activePresetId: presetId });
    this.set({ settings });
  };

  readonly cancelExport = async (jobId: ExportJobId): Promise<void> => {
    try {
      await this.bridge.invoke('export:cancel', { jobId });
      await this.refreshExportJobs();
    } catch (cause) {
      this.toast('error', `Could not cancel the export: ${messageOf(cause)}`);
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
      case 'export.render': {
        this.renderChain = this.renderChain
          .then(() => this.performExportRender(event))
          .catch(() => undefined);
        break;
      }
      case 'export.progress':
      case 'export.state': {
        const known = this.state.exportJobs.some((job) => job.id === event.job.id);
        this.set({
          exportJobs: known
            ? this.state.exportJobs.map((job) => (job.id === event.job.id ? event.job : job))
            : [event.job, ...this.state.exportJobs],
        });
        this.notifyExportWaiter(event.job);
        break;
      }
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
  readonly toggleBatchCaption = (open?: boolean): void => {
    this.set({ batchCaptionOpen: open ?? !this.state.batchCaptionOpen, dialog: undefined });
  };
  readonly closeDialog = (): void => this.set({ dialog: undefined });
  readonly toggleShortcuts = (open?: boolean): void => {
    this.set({ shortcutsOpen: open ?? !this.state.shortcutsOpen, dialog: undefined });
  };
}

export interface CreateAppStoreOptions {
  /** Replaces the full-resolution renderer in tests. */
  renderForExport?: typeof renderFullResolution;
  /** Confirmation for exporting without a retouched photo's mosaic. */
  confirm?: (message: string) => boolean;
  /**
   * Draws the edited thumbnail and preview of a photo. Without it nothing is
   * rendered and the film strip keeps showing what the backend cached.
   */
  renderEditedPreview?: EditedPreviewRenderer;
}

/** Build a store against a bridge; the app uses the preload bridge, tests a fake. */
export function createAppStore(bridge: EeBridge, options: CreateAppStoreOptions = {}): AppStore {
  return new AppStore(
    bridge,
    options.renderForExport,
    options.renderEditedPreview,
    options.confirm,
  );
}
