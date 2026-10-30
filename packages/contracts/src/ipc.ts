import type { ApplyDevelopSettingsArgs, EditParams, EditPreset } from './develop';
import type {
  CredentialSecret,
  DeliverExportRenderArgs,
  Destination,
  ExportJob,
  ExportPreset,
  RenderedImage,
  StartExportArgs,
  UploadItem,
} from './export';
import type {
  DestinationId,
  ExportJobId,
  PhotoId,
  PresetId,
  SourceId,
  UploadId,
  VersionId,
} from './ids';
import type { IptcFields } from './iptc';
import type { JobEvent, IngestJobInfo } from './jobs';
import type { Photo, PhotoVersion } from './photo';
import type { PhotoProfiles, ProfileIndex, ProfileRequest, ProfileResolution } from './profile';
import type { Rect } from './geometry';
import type { FaceDetection, RetouchOp } from './retouch';
import type { DetectedCard, IngestConfig, SourceConfig, TemplateApplyMode } from './sources';

// ---------------------------------------------------------------------------
// Request / response payloads
// ---------------------------------------------------------------------------

/** Result of `system:ping`: proves renderer → main → jobs → main → renderer. */
export interface PingResult {
  /** The message that was sent, echoed by the jobs process. */
  echo: string;
  /** Process id of the jobs utility process that answered. */
  jobsPid: number;
  /** `Date.now()` in the jobs process when it answered. */
  jobsTime: number;
}

/** Static facts about the running app. */
export interface SystemInfo {
  appVersion: string;
  /** Version reported by the native core addon. */
  coreVersion: string;
  platform: string;
  /** True when started with `EE_MOCK=1`: photos are generated, nothing touches disk. */
  mock: boolean;
}

/** Arguments of `photos:list`. */
export interface ListPhotosArgs {
  /** Only photos from this source. */
  sourceId?: SourceId;
}

/** Outcome of probing a source or destination. */
export interface ConnectionTestResult {
  ok: boolean;
  /** Human-readable detail, e.g. the server banner or the failure reason. */
  message?: string;
}

/** Arguments of `metadata:write`. */
export interface WriteMetadataArgs {
  photoId: PhotoId;
  /** Fields to set; fields not listed are left as they are. */
  fields: Partial<IptcFields>;
}

/** Arguments of `metadata:applyTemplate`. */
export interface ApplyTemplateArgs {
  photoIds: PhotoId[];
  templatePath: string;
  /** `replace` overwrites every field the template sets; `fillEmpty` only empty ones. */
  mode: TemplateApplyMode;
}

/** Outcome of `metadata:applyTemplate`; partial failure does not reject. */
export interface ApplyTemplateResult {
  updated: PhotoId[];
  failed: { photoId: PhotoId; message: string }[];
}

/** Arguments of `metadata:expandCaption`. */
export interface ExpandCaptionArgs {
  /** Photo whose metadata/EXIF feeds the `{variables}`. */
  photoId: PhotoId;
  /** Caption text containing code replacements (`\name\`) and `{variables}`. */
  text: string;
  /** Overrides the code replacement files configured in settings. */
  codeReplacementPaths?: string[];
}

/** Outcome of `metadata:expandCaption`. */
export interface ExpandCaptionResult {
  /** Fully expanded text. */
  text: string;
  /** Code replacement names and `{variables}` that could not be resolved (left verbatim). */
  unresolved: string[];
}

/** Addresses one version of a photo; omit `versionId` for the active develop/retouch version. */
export interface VersionRef {
  photoId: PhotoId;
  versionId?: VersionId;
}

/** Arguments of `photos:createVersion`. */
export interface CreateVersionArgs {
  photoId: PhotoId;
  kind: PhotoVersion['kind'];
  name?: string;
}

/** Arguments of `photos:deleteVersion`. */
export interface DeleteVersionArgs {
  photoId: PhotoId;
  versionId: VersionId;
}

/** Arguments of `photos:setLabels`. Omitted fields are left unchanged. */
export interface SetPhotoLabelsArgs {
  photoIds: PhotoId[];
  /** Photo Mechanic tag flag. */
  tagged?: boolean;
  /** Colour class: 0 = none, 1..8. */
  colorClass?: number;
  /** Star rating: 0 = none, 1..5. */
  rating?: number;
}

/** Arguments of `photos:setEditedPreview`. */
export interface SetEditedPreviewArgs {
  photoId: PhotoId;
  /**
   * Orders renders of one photo: the backend ignores a render older than one it
   * already stored. Must grow with every edit, also across app restarts.
   */
  revision: number;
  /**
   * The retouch ops baked into the pixels (the newest retouch version's). The
   * backend refuses a render whose ops differ from the photo's current ones, so
   * an old render can never put an unmosaicked face back.
   */
  retouchOps: RetouchOp[];
  /**
   * The develop params the pixels were drawn with. The backend refuses a render when
   * it has since received other params for the photo, so a render of older slider
   * values can never mark the photo's previews as up to date.
   */
  params: EditParams;
  /** About 320 px on the long edge, upright and cropped. */
  thumb: RenderedImage;
  /** About 2560 px on the long edge, upright and cropped. */
  preview: RenderedImage;
}

/** Arguments of `retouch:detectFaces`. */
export interface DetectFacesArgs {
  photoId: PhotoId;
  /** Only look inside this region (normalized coordinates); absent = whole image. */
  region?: Rect;
}

/** Ingest options that are not tied to the set of sources. */
export type IngestSettings = Omit<IngestConfig, 'sources'>;

/** Persisted user settings. */
export interface AppSettings {
  ingest: IngestSettings;
  /** Local root for every export; relative preset folder templates live below it. */
  exportRoot: string;
  exportPresets: ExportPreset[];
  /** Preset used by Next & send. */
  activePresetId?: PresetId;
  /**
   * Folders the user added to the camera profile search (DNG `.dcp` and XMP profiles), besides
   * Adobe's own folders where they exist on this machine. Scanned recursively.
   */
  profileFolders?: string[];
}

/** Arguments of `dialog:pick`. */
export interface PickPathArgs {
  kind: 'file' | 'folder';
  title?: string;
  /** File name extensions without the dot, e.g. `['xmp']`. */
  extensions?: string[];
  multiple?: boolean;
}

// ---------------------------------------------------------------------------
// The IPC map
// ---------------------------------------------------------------------------

/**
 * Every request/response channel between renderer and the backend.
 *
 * Conventions:
 * - Channel names are `<namespace>:<action>`. The namespace decides which
 *   process serves the channel (see the routing table in `apps/desktop`).
 * - Each channel takes at most one argument object and returns a Promise.
 * - Failures reject with an {@link IpcError}; never resolve with an error value.
 * - Binary data is passed as `Uint8Array`; large images are served over
 *   `app://` instead (see `appUrl`).
 *
 * Adding a channel: add it here, add its name to {@link INVOKE_CHANNELS} (a
 * type test fails if you forget), then implement it in exactly one handler.
 */
export interface IpcApi {
  // --- system ---
  'system:ping': (args: { message: string }) => Promise<PingResult>;
  'system:info': () => Promise<SystemInfo>;

  // --- photos (the index) ---
  'photos:list': (args?: ListPhotosArgs) => Promise<Photo[]>;
  'photos:get': (args: { photoId: PhotoId }) => Promise<Photo>;
  'photos:createVersion': (args: CreateVersionArgs) => Promise<PhotoVersion>;
  /** Delete a retouch version and its ops. The develop version cannot be deleted. */
  'photos:deleteVersion': (args: DeleteVersionArgs) => Promise<Photo>;
  /** Persist tag and colour class in the index and in the sidecar (or embedded XMP). */
  'photos:setLabels': (args: SetPhotoLabelsArgs) => Promise<Photo[]>;
  /**
   * Store the edited thumbnail and preview rendered by the renderer. Resolves with
   * the photo as it is now; `previewStale` is still set when the render was refused
   * because the edits changed meanwhile.
   */
  'photos:setEditedPreview': (args: SetEditedPreviewArgs) => Promise<Photo>;

  // --- ingest ---
  /** Start ingesting every source in the config, in parallel. Returns one job per source. */
  'ingest:start': (args: { config: IngestConfig }) => Promise<IngestJobInfo[]>;
  /** Stop one source's run, or all runs when `sourceId` is omitted. Idempotent. */
  'ingest:stop': (args?: { sourceId?: SourceId }) => Promise<void>;
  'ingest:status': () => Promise<IngestJobInfo[]>;

  // --- sources (CRUD of configured sources) ---
  'sources:list': () => Promise<SourceConfig[]>;
  /** Insert or update (matched by `id`). */
  'sources:save': (args: { source: SourceConfig }) => Promise<SourceConfig>;
  'sources:remove': (args: { sourceId: SourceId }) => Promise<void>;
  'sources:test': (args: { source: SourceConfig }) => Promise<ConnectionTestResult>;
  /** Removable volumes that look like camera cards. Platform specific. */
  'sources:detectCards': () => Promise<DetectedCard[]>;

  // --- destinations (CRUD of upload/export destinations) ---
  'destinations:list': () => Promise<Destination[]>;
  'destinations:save': (args: { destination: Destination }) => Promise<Destination>;
  'destinations:remove': (args: { destinationId: DestinationId }) => Promise<void>;
  'destinations:test': (args: { destination: Destination }) => Promise<ConnectionTestResult>;

  // --- credentials (write-only from the renderer) ---
  /** Store a secret via `safeStorage`; returns the `credentialRef` to put in a source/destination. */
  'credentials:set': (args: { secret: CredentialSecret; ref?: string }) => Promise<{ ref: string }>;
  'credentials:remove': (args: { ref: string }) => Promise<void>;

  // --- metadata ---
  'metadata:read': (args: { photoId: PhotoId }) => Promise<IptcFields>;
  /** Write fields to the sidecar (raw) or file (JPEG); returns the updated photo. */
  'metadata:write': (args: WriteMetadataArgs) => Promise<Photo>;
  /** Parse a Photo Mechanic `.XMP` template without applying it. */
  'metadata:readTemplate': (args: { path: string }) => Promise<IptcFields>;
  'metadata:applyTemplate': (args: ApplyTemplateArgs) => Promise<ApplyTemplateResult>;
  'metadata:expandCaption': (args: ExpandCaptionArgs) => Promise<ExpandCaptionResult>;

  // --- develop ---
  'develop:getParams': (args: VersionRef) => Promise<EditParams>;
  /**
   * What a photo starts with when the sidecar does not set it: Lightroom's raw
   * sharpening and colour noise reduction, or the camera's own `crd:` values
   * (see `RAW_DETAIL_DEFAULTS`). Empty for JPEG and TIFF. These are not edits and
   * are never written; a renderer shows and renders `withDefaults(params, defaults)`.
   */
  'develop:getDefaults': (args: { photoId: PhotoId }) => Promise<EditParams>;
  /** Replaces the whole parameter set of the version. */
  'develop:setParams': (args: VersionRef & { params: EditParams }) => Promise<void>;
  /**
   * Copies the selected setting groups from `params` onto every photo in one
   * call. Each photo keeps the groups that were not selected; retouch versions
   * are never touched. Resolves with the updated photos.
   */
  'develop:applySettings': (args: ApplyDevelopSettingsArgs) => Promise<Photo[]>;
  'develop:listPresets': () => Promise<EditPreset[]>;
  /** Parse a Lightroom/Camera Raw `.xmp` preset and remember it. */
  'develop:importPreset': (args: { path: string }) => Promise<EditPreset>;

  // --- camera profiles (the user's DCP and XMP files; see `docs/ARCHITECTURE.md`) ---
  /** The profiles that fit a photo's camera, for the Develop panel's profile select. */
  'profiles:list': (args: { photoId: PhotoId }) => Promise<PhotoProfiles>;
  /** Everything found in the profile folders, files that could not be read, and the folders scanned. */
  'profiles:index': (args?: { rescan?: boolean }) => Promise<ProfileIndex>;
  /** Loads the profile (and look) a sidecar names for a photo, or says why it cannot. */
  'profiles:resolve': (args: ProfileRequest) => Promise<ProfileResolution>;

  // --- retouch ---
  'retouch:get': (args: VersionRef) => Promise<RetouchOp[]>;
  /** Replaces the whole op list of the version. */
  'retouch:set': (args: VersionRef & { ops: RetouchOp[] }) => Promise<void>;
  'retouch:detectFaces': (args: DetectFacesArgs) => Promise<FaceDetection[]>;

  // --- export presets ---
  'exportPresets:list': () => Promise<ExportPreset[]>;
  /** Insert or update (matched by `id`); returns the stored preset. */
  'exportPresets:save': (args: { preset: ExportPreset }) => Promise<ExportPreset>;
  'exportPresets:remove': (args: { presetId: PresetId }) => Promise<void>;

  // --- export jobs (renderer renders, jobs process encodes and sends) ---
  'export:start': (args: StartExportArgs) => Promise<ExportJobId>;
  'export:cancel': (args: { jobId: ExportJobId }) => Promise<void>;
  'export:list': () => Promise<ExportJob[]>;
  /** Renderer's reply to an `export.render` event. */
  'export:render': (args: DeliverExportRenderArgs) => Promise<void>;
  /** Tells the jobs process the renderer is listening again (after a reload or restart). */
  'export:rendererReady': () => Promise<void>;

  // --- upload queue ---
  'upload:list': () => Promise<UploadItem[]>;
  'upload:retry': (args: { uploadId: UploadId }) => Promise<void>;
  'upload:cancel': (args: { uploadId: UploadId }) => Promise<void>;

  // --- settings & dialogs (served by the main process) ---
  'settings:get': () => Promise<AppSettings>;
  /** Shallow-merges the given top-level keys; returns the result. */
  'settings:set': (args: Partial<AppSettings>) => Promise<AppSettings>;
  /** Native open dialog. Resolves with an empty array when cancelled. */
  'dialog:pick': (args: PickPathArgs) => Promise<string[]>;
}

/** Push channels (backend → renderer): channel name → payload. */
export interface IpcEvents {
  'photos:added': Photo;
  'photos:updated': Photo;
  'jobs:event': JobEvent;
}

// ---------------------------------------------------------------------------
// Channel registry (runtime) and derived helper types
// ---------------------------------------------------------------------------

/** Every request/response channel name. Must list exactly the keys of {@link IpcApi}. */
export const INVOKE_CHANNELS = [
  'system:ping',
  'system:info',
  'photos:list',
  'photos:get',
  'photos:createVersion',
  'photos:deleteVersion',
  'photos:setLabels',
  'photos:setEditedPreview',
  'ingest:start',
  'ingest:stop',
  'ingest:status',
  'sources:list',
  'sources:save',
  'sources:remove',
  'sources:test',
  'sources:detectCards',
  'destinations:list',
  'destinations:save',
  'destinations:remove',
  'destinations:test',
  'credentials:set',
  'credentials:remove',
  'metadata:read',
  'metadata:write',
  'metadata:readTemplate',
  'metadata:applyTemplate',
  'metadata:expandCaption',
  'develop:getParams',
  'develop:getDefaults',
  'develop:setParams',
  'develop:applySettings',
  'develop:listPresets',
  'develop:importPreset',
  'profiles:list',
  'profiles:index',
  'profiles:resolve',
  'retouch:get',
  'retouch:set',
  'retouch:detectFaces',
  'exportPresets:list',
  'exportPresets:save',
  'exportPresets:remove',
  'export:start',
  'export:cancel',
  'export:list',
  'export:render',
  'export:rendererReady',
  'upload:list',
  'upload:retry',
  'upload:cancel',
  'settings:get',
  'settings:set',
  'dialog:pick',
] as const satisfies readonly (keyof IpcApi)[];

/** Every push channel name. Must list exactly the keys of {@link IpcEvents}. */
export const EVENT_CHANNELS = [
  'photos:added',
  'photos:updated',
  'jobs:event',
] as const satisfies readonly (keyof IpcEvents)[];

/** Name of a request/response channel. */
export type InvokeChannel = keyof IpcApi;
/** Name of a push channel. */
export type EventChannel = keyof IpcEvents;

/** Parameter list of a channel: `[]`, `[args]` or `[args?]`. Spread it into `invoke`. */
export type ArgsOf<C extends InvokeChannel> = Parameters<IpcApi[C]>;
/** Resolved value of a channel. */
export type ResultOf<C extends InvokeChannel> = Awaited<ReturnType<IpcApi[C]>>;
/** Payload of a push channel. */
export type EventPayload<E extends EventChannel> = IpcEvents[E];

/** Namespace part of a channel name (`'photos'` for `'photos:list'`). */
export type IpcNamespace = InvokeChannel extends infer C
  ? C extends `${infer N}:${string}`
    ? N
    : never
  : never;
/** Channels of one namespace. */
export type NamespaceChannels<N extends IpcNamespace> = Extract<InvokeChannel, `${N}:${string}`>;

/**
 * Handler implementations for a set of channels. The full set of handlers is
 * `IpcHandlers`; split by namespace with `NamespaceHandlers<'photos'>` so each
 * module implements (and is type-checked against) only its own channels.
 */
export type IpcHandlers = { [C in InvokeChannel]: IpcApi[C] };
/** Handlers for one namespace. */
export type NamespaceHandlers<N extends IpcNamespace> = Pick<IpcApi, NamespaceChannels<N>>;

/** Namespace of a channel name at runtime. */
export function channelNamespace(channel: InvokeChannel): IpcNamespace {
  return channel.slice(0, channel.indexOf(':')) as IpcNamespace;
}

// ---------------------------------------------------------------------------
// Errors and the wire envelope
// ---------------------------------------------------------------------------

/** Machine-readable failure classes. */
export type IpcErrorCode =
  | 'not_implemented'
  | 'not_found'
  | 'invalid_argument'
  | 'cancelled'
  | 'io'
  | 'network'
  | 'auth'
  | 'internal';

/** Serializable form of an {@link IpcError}; this is what crosses process boundaries. */
export interface IpcErrorShape {
  code: IpcErrorCode;
  message: string;
}

/** Typed error thrown by handlers and rethrown on the renderer side of a failed invoke. */
export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IpcError';
    this.code = code;
  }

  toShape(): IpcErrorShape {
    return { code: this.code, message: this.message };
  }
}

/**
 * Envelope used on the wire. Electron flattens errors thrown inside
 * `ipcMain.handle` to a message string, so handlers' failures travel as data
 * and the preload bridge turns them back into {@link IpcError}s.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcErrorShape };

/** Run a handler and capture its outcome (or its error) as an {@link IpcResult}. */
export async function toIpcResult<T>(run: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof IpcError) return { ok: false, error: error.toShape() };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'internal', message } };
  }
}

/** Turn an {@link IpcResult} back into a value, or throw the {@link IpcError}. */
export function unwrapIpcResult<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw new IpcError(result.error.code, result.error.message);
}

/** A handler for a channel that is declared but not built yet. Rejects `not_implemented`. */
export function notImplemented(channel: InvokeChannel): () => Promise<never> {
  return () => Promise.reject(new IpcError('not_implemented', `${channel} is not implemented yet`));
}

// ---------------------------------------------------------------------------
// Preload bridge
// ---------------------------------------------------------------------------

/** Stops a subscription. */
export type Unsubscribe = () => void;

/** The typed API the preload script exposes as `window.ee`. */
export interface EeBridge {
  /** Call a backend channel. Rejects with {@link IpcError}. */
  invoke<C extends InvokeChannel>(channel: C, ...args: ArgsOf<C>): Promise<ResultOf<C>>;
  /** Subscribe to a push channel. */
  on<E extends EventChannel>(channel: E, listener: (payload: EventPayload<E>) => void): Unsubscribe;
}

/**
 * The untyped transport underneath the bridge. In Electron this is a thin
 * wrapper over `ipcRenderer.invoke` / `ipcRenderer.on`; in tests it can be an
 * in-memory fake.
 */
export interface BridgeTransport {
  invoke(channel: InvokeChannel, args: unknown[]): Promise<IpcResult<unknown>>;
  subscribe(channel: EventChannel, listener: (payload: unknown) => void): Unsubscribe;
}

/** Build the typed {@link EeBridge} on top of a {@link BridgeTransport}. */
export function createBridge(transport: BridgeTransport): EeBridge {
  return {
    async invoke(channel, ...args) {
      const result = await transport.invoke(channel, args);
      return unwrapIpcResult(result) as never;
    },
    on(channel, listener) {
      return transport.subscribe(channel, (payload) => listener(payload as never));
    },
  };
}
