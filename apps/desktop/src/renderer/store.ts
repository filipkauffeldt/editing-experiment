import {
  SLIDER_SPECS,
  type AppSettings,
  type CredentialSecret,
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
  type SourceConfig,
  type SourceId,
  type TemplateApplyMode,
  type UploadItem,
  type VersionId,
} from '@ee/contracts';

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
  /** Local until the contracts grow a persisted tag field. */
  tagged: boolean;
  /** 0 = none, 1..8 = colour class. */
  colorClass: number;
}

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
  flags: Record<string, PhotoFlags>;
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

const DEFAULT_FLAGS: PhotoFlags = { tagged: false, colorClass: 0 };

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
  return state.flags[photoId] ?? DEFAULT_FLAGS;
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
      return !photoFlags(state, photo.id).tagged;
    case 'tagged':
      return photoFlags(state, photo.id).tagged;
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

const naturalName = (left: Photo, right: Photo): number =>
  left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: 'base' });

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
  flags: {},
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
  private readonly developTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingMetadata = new Map<PhotoId, Partial<IptcFields>>();
  private toastId = 0;
  private started = false;
  private finishing = false;

  constructor(private readonly bridge: EeBridge) {}

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

  // ---------------------------------------------------------------- lifecycle

  readonly init = async (): Promise<void> => {
    if (this.started) return;
    this.started = true;
    this.unsubscribers.push(
      this.bridge.on('photos:added', (photo) => this.upsertPhoto(photo)),
      this.bridge.on('photos:updated', (photo) => this.upsertPhoto(photo)),
      this.bridge.on('jobs:event', (event) => this.handleJobEvent(event)),
    );
    await this.loadAll();
  };

  readonly dispose = (): void => {
    this.started = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const timer of this.metadataTimers.values()) clearTimeout(timer);
    this.metadataTimers.clear();
    for (const timer of this.developTimers.values()) clearTimeout(timer);
    this.developTimers.clear();
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

    const loadedPhotos = value(photos) ?? [];
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

    const first = selectVisiblePhotos(this.getState())[0];
    if (first) this.select(first.id);
  }

  // ------------------------------------------------------------------- photos

  private upsertPhoto(photo: Photo): void {
    const exists = this.state.photos.some((candidate) => candidate.id === photo.id);
    this.set({
      photos: exists
        ? this.state.photos.map((candidate) => (candidate.id === photo.id ? photo : candidate))
        : [...this.state.photos, photo],
    });
  }

  readonly select = (photoId: PhotoId | undefined): void => {
    if (photoId === this.state.selectedId) return;
    this.set({ selectedId: photoId });
    if (!photoId) return;
    void this.loadMetadata(photoId);
    void this.loadParams(photoId);
  };

  readonly selectRelative = (delta: number): void => {
    const photos = selectVisiblePhotos(this.state);
    if (photos.length === 0) return;
    const index = photos.findIndex((photo) => photo.id === this.state.selectedId);
    const next = photos[Math.max(0, Math.min(photos.length - 1, index + delta))];
    if (next) this.select(next.id);
  };

  private ensureSelectionVisible(): void {
    const visible = selectVisiblePhotos(this.state);
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

  readonly toggleTag = (photoId?: PhotoId): void => {
    const id = photoId ?? this.state.selectedId;
    if (!id) return;
    const flags = photoFlags(this.state, id);
    this.set({
      flags: { ...this.state.flags, [id]: { ...flags, tagged: !flags.tagged } },
    });
    this.ensureSelectionVisible();
  };

  readonly setColorClass = (colorClass: number, photoId?: PhotoId): void => {
    const id = photoId ?? this.state.selectedId;
    if (!id || colorClass < 0 || colorClass > 8) return;
    const flags = photoFlags(this.state, id);
    this.set({ flags: { ...this.state.flags, [id]: { ...flags, colorClass } } });
  };

  // ----------------------------------------------------------------- metadata

  private async loadMetadata(photoId: PhotoId): Promise<void> {
    try {
      const fields = await this.bridge.invoke('metadata:read', { photoId });
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

  readonly saveMetadata = async (photoId: PhotoId): Promise<void> => {
    const fields = this.pendingMetadata.get(photoId);
    if (!fields) return;
    this.pendingMetadata.delete(photoId);
    const timer = this.metadataTimers.get(photoId);
    if (timer) {
      clearTimeout(timer);
      this.metadataTimers.delete(photoId);
    }
    try {
      const photo = await this.bridge.invoke('metadata:write', { photoId, fields });
      this.upsertPhoto(photo);
    } catch (cause) {
      this.toast('error', `Could not save metadata: ${messageOf(cause)}`);
    }
  };

  readonly expandCaption = async (
    photoId?: PhotoId,
  ): Promise<{ text: string; unresolved: string[] } | undefined> => {
    const id = photoId ?? this.state.selectedId;
    if (!id) return undefined;
    const text = this.state.metadata[id]?.caption ?? '';
    if (!text) return undefined;
    try {
      const result = await this.bridge.invoke('metadata:expandCaption', { photoId: id, text });
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
    const photo = this.state.photos.find((candidate) => candidate.id === photoId);
    const versionId = activeDevelopVersion(photo)?.id;
    try {
      const params = await this.bridge.invoke('develop:getParams', { photoId, versionId });
      this.set({
        editParams: { ...this.state.editParams, [editParamsKey(photoId, versionId)]: params },
      });
    } catch (cause) {
      this.toast('error', `Could not read develop settings: ${messageOf(cause)}`);
    }
  }

  private scheduleDevelopSave(
    photoId: PhotoId,
    versionId: VersionId | undefined,
    params: EditParams,
  ): void {
    const key = editParamsKey(photoId, versionId);
    const existing = this.developTimers.get(key);
    if (existing) clearTimeout(existing);
    this.developTimers.set(
      key,
      setTimeout(() => {
        this.developTimers.delete(key);
        void this.bridge
          .invoke('develop:setParams', { photoId, versionId, params })
          .catch((cause: unknown) =>
            this.toast('error', `Could not save develop settings: ${messageOf(cause)}`),
          );
      }, 180),
    );
  }

  private patchParams(updater: (current: EditParams) => EditParams): void {
    const photo = activePhoto(this.state);
    if (!photo) return;
    const versionId = activeDevelopVersion(photo)?.id;
    const key = editParamsKey(photo.id, versionId);
    const next = updater(this.state.editParams[key] ?? {});
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

  readonly applyPreset = (preset: EditPreset): void => {
    const unsupported = unsupportedSettings(preset);
    this.patchParams((current) => ({ ...current, ...preset.params }));
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

  readonly finishAndNext = async (): Promise<void> => {
    if (this.finishing) return;
    const photo = activePhoto(this.state);
    if (!photo) return;
    this.finishing = true;
    try {
      const versionId = activeDevelopVersion(photo)?.id;
      const result = await this.bridge.invoke('export:photo', {
        photoId: photo.id,
        versionId,
        // The real renderer hands over the full-resolution RGBA buffer; the
        // mock backend ignores it. @ee/develop-gl integration replaces this.
        rendered: { width: 1, height: 1, rgba: new Uint8Array(4) },
      });
      this.toast('success', `Exported ${result.path.split('/').pop() ?? photo.fileName}`);
      this.selectRelative(1);
    } catch (cause) {
      this.toast('error', `Export failed: ${messageOf(cause)}`);
    } finally {
      this.finishing = false;
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
    if (secret && (next.kind === 'ftp' || next.kind === 'sftp')) {
      const { ref } = await this.bridge.invoke('credentials:set', {
        secret,
        ref: next.credentialRef,
      });
      next = { ...next, credentialRef: ref };
    }
    const saved = await this.bridge.invoke('sources:save', { source: next });
    const sources = this.state.sources.some((candidate) => candidate.id === saved.id)
      ? this.state.sources.map((candidate) => (candidate.id === saved.id ? saved : candidate))
      : [...this.state.sources, saved];
    this.set({ sources });
    return saved;
  };

  readonly removeSource = async (sourceId: SourceId): Promise<void> => {
    await this.bridge.invoke('sources:remove', { sourceId });
    this.set({ sources: this.state.sources.filter((source) => source.id !== sourceId) });
  };

  readonly testSource = (source: SourceConfig) => this.bridge.invoke('sources:test', { source });

  readonly saveDestination = async (
    destination: Destination,
    secret?: CredentialSecret,
  ): Promise<Destination> => {
    let next = destination;
    if (secret && (next.kind === 'ftp' || next.kind === 'sftp')) {
      const { ref } = await this.bridge.invoke('credentials:set', {
        secret,
        ref: next.credentialRef,
      });
      next = { ...next, credentialRef: ref };
    }
    const saved = await this.bridge.invoke('destinations:save', { destination: next });
    const destinations = this.state.destinations.some((candidate) => candidate.id === saved.id)
      ? this.state.destinations.map((candidate) => (candidate.id === saved.id ? saved : candidate))
      : [...this.state.destinations, saved];
    this.set({ destinations });
    return saved;
  };

  readonly removeDestination = async (destination: Destination['id']): Promise<void> => {
    await this.bridge.invoke('destinations:remove', { destinationId: destination });
    this.set({
      destinations: this.state.destinations.filter((item) => item.id !== destination),
    });
  };

  readonly testDestination = (destination: Destination) =>
    this.bridge.invoke('destinations:test', { destination });

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

/** Build a store against a bridge; the app uses the preload bridge, tests a fake. */
export function createAppStore(bridge: EeBridge): AppStore {
  return new AppStore(bridge);
}
