import {
  applyDevelopSettingGroups,
  asPresetId,
  asVersionId,
  createBridge,
  toIpcResult,
  type BridgeTransport,
  type EeBridge,
  type EditParams,
  type EventChannel,
  type ExportJob,
  type ExportPreset,
  type InvokeChannel,
  type IptcFields,
  type Photo,
  type PhotoId,
  type SourceConfig,
  type UploadItem,
  type VersionId,
} from '@ee/contracts';
import {
  expandMockCaption,
  mockDestinations,
  mockMetadata,
  mockPhotos,
  mockPresets,
  mockSettings,
  mockSources,
  mockTemplate,
  mockUploads,
} from '../src/shared/mock';

type Handler = (...args: unknown[]) => Promise<unknown>;

export interface FakeBridge {
  bridge: EeBridge;
  transport: BridgeTransport;
  calls: { channel: InvokeChannel; args: unknown[] }[];
  emit(channel: EventChannel, payload: unknown): void;
  uploads: UploadItem[];
  settings: ReturnType<typeof mockSettings>;
  exportPresets: ExportPreset[];
}

const versionKey = (photoId: PhotoId, versionId?: VersionId): string =>
  `${photoId}:${versionId ?? 'active'}`;

/**
 * In-memory implementation of every channel the renderer uses. Tests can
 * override single channels and inspect the calls that crossed the bridge.
 */
export function createFakeBridge(
  options: {
    photos?: Photo[];
    handlers?: Partial<Record<InvokeChannel, Handler>>;
  } = {},
): FakeBridge {
  const photos = options.photos ?? mockPhotos();
  const metadata = new Map<PhotoId, IptcFields>(
    photos.map((photo, index) => [photo.id, mockMetadata(index + 1)]),
  );
  const params = new Map<string, EditParams>();
  for (const photo of photos) {
    const develop = photo.versions.find((version) => version.kind === 'develop');
    params.set(versionKey(photo.id, develop?.id), develop?.kind === 'develop' ? develop.ops : {});
  }
  let settings = mockSettings();
  const uploads = mockUploads();
  const sources = mockSources();
  const destinations = mockDestinations();
  const presets = mockPresets();
  let exportPresets = mockSettings().exportPresets as ExportPreset[];
  const exportJobs: ExportJob[] = [];
  let exportSequence = 0;
  let exportRequestSequence = 0;
  const renderWaiters = new Map<
    string,
    (outcome: { rendered?: unknown; error?: string }) => void
  >();
  const template = mockTemplate();
  const calls: FakeBridge['calls'] = [];
  const listeners = new Map<EventChannel, Set<(payload: unknown) => void>>();

  const emit = (channel: EventChannel, payload: unknown): void => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };

  const findPhoto = (photoId: PhotoId): Photo => {
    const photo = photos.find((candidate) => candidate.id === photoId);
    if (!photo) throw new Error(`no photo ${photoId}`);
    return photo;
  };

  const defaults: Partial<Record<InvokeChannel, Handler>> = {
    'system:info': async () => ({
      appVersion: '0.0.0-test',
      coreVersion: '0.0.0-test',
      platform: 'linux',
      mock: true,
    }),
    'system:ping': async (...args) => {
      const { message } = args[0] as { message: string };
      return { echo: message, jobsPid: 1, jobsTime: 0 };
    },
    'photos:list': async () => photos,
    'photos:get': async (...args) => findPhoto((args[0] as { photoId: PhotoId }).photoId),
    'photos:createVersion': async (...args) => {
      const { photoId, kind, name } = args[0] as {
        photoId: PhotoId;
        kind: 'develop' | 'retouch';
        name?: string;
      };
      const photo = findPhoto(photoId);
      const version = {
        id: asVersionId(`test-version-${photo.versions.length + 1}`),
        kind,
        ...(name === undefined ? {} : { name }),
        ops: kind === 'develop' ? {} : [],
      } as Photo['versions'][number];
      photo.versions = [...photo.versions, version];
      return version;
    },
    'photos:setLabels': async (...args) => {
      const { photoIds, tagged, colorClass, rating } = args[0] as {
        photoIds: PhotoId[];
        tagged?: boolean;
        colorClass?: number;
        rating?: number;
      };
      return photoIds.map((photoId) => {
        const photo = findPhoto(photoId);
        if (tagged !== undefined) photo.tagged = tagged;
        if (colorClass !== undefined) photo.colorClass = colorClass;
        if (rating !== undefined) photo.rating = rating;
        return photo;
      });
    },
    'photos:setEditedPreview': async (...args) => {
      const { photoId } = args[0] as { photoId: PhotoId };
      const index = photos.findIndex((candidate) => candidate.id === photoId);
      const current = findPhoto(photoId);
      const next: Photo = {
        ...current,
        previewRevision: (current.previewRevision ?? 0) + 1,
        previewStale: false,
      };
      photos[index] = next;
      emit('photos:updated', next);
      return next;
    },
    'photos:deleteVersion': async (...args) => {
      const { photoId, versionId } = args[0] as { photoId: PhotoId; versionId: VersionId };
      const photo = findPhoto(photoId);
      const version = photo.versions.find((candidate) => candidate.id === versionId);
      if (!version) throw new Error(`no version ${versionId}`);
      photo.versions = photo.versions.filter((candidate) => candidate.id !== versionId);
      return photo;
    },
    'sources:list': async () => sources,
    'sources:save': async (...args) => {
      const { source } = args[0] as { source: SourceConfig };
      const index = sources.findIndex((candidate) => candidate.id === source.id);
      if (index >= 0) sources[index] = source;
      else sources.push(source);
      return source;
    },
    'sources:remove': async (...args) => {
      const { sourceId } = args[0] as { sourceId: SourceConfig['id'] };
      const index = sources.findIndex((candidate) => candidate.id === sourceId);
      if (index >= 0) sources.splice(index, 1);
    },
    'sources:test': async () => ({ ok: true, message: 'Connection OK (test)' }),
    'sources:detectCards': async () => [],
    'destinations:list': async () => destinations,
    'destinations:save': async (...args) => {
      const { destination } = args[0] as { destination: (typeof destinations)[number] };
      const index = destinations.findIndex((candidate) => candidate.id === destination.id);
      if (index >= 0) destinations[index] = destination;
      else destinations.push(destination);
      return destination;
    },
    'destinations:remove': async (...args) => {
      const { destinationId } = args[0] as { destinationId: (typeof destinations)[number]['id'] };
      const index = destinations.findIndex((candidate) => candidate.id === destinationId);
      if (index >= 0) destinations.splice(index, 1);
    },
    'destinations:test': async () => ({ ok: true, message: 'Connected (test)' }),
    'ingest:start': async (...args) => {
      const { config } = args[0] as { config: { sources: SourceConfig[] } };
      return config.sources.map((source, index) => ({
        jobId: `test-ingest-${index}` as never,
        sourceId: source.id,
        state: 'running' as const,
        filesTotal: 20,
        filesDone: 0,
        bytesDone: 0,
      }));
    },
    'ingest:stop': async () => {},
    'ingest:status': async () =>
      sources.map((source, index) => ({
        jobId: `test-ingest-${index}` as never,
        sourceId: source.id,
        state: 'running' as const,
        filesTotal: 20,
        filesDone: index === 0 ? 14 : 8,
        bytesDone: 0,
      })),
    'metadata:read': async (...args) =>
      metadata.get((args[0] as { photoId: PhotoId }).photoId) ?? {},
    'metadata:write': async (...args) => {
      const { photoId, fields } = args[0] as { photoId: PhotoId; fields: Partial<IptcFields> };
      const photo = findPhoto(photoId);
      metadata.set(photoId, { ...(metadata.get(photoId) ?? {}), ...fields });
      return photo;
    },
    'metadata:readTemplate': async () => template,
    'metadata:applyTemplate': async (...args) => {
      const { photoIds, mode } = args[0] as { photoIds: PhotoId[]; mode: 'replace' | 'fillEmpty' };
      for (const photoId of photoIds) {
        const current = metadata.get(photoId) ?? {};
        const next = mode === 'replace' ? { ...template } : { ...current };
        if (mode === 'fillEmpty') {
          for (const [key, value] of Object.entries(template)) {
            const target = (next as Record<string, unknown>)[key];
            if (
              target === undefined ||
              target === '' ||
              (Array.isArray(target) && target.length === 0)
            ) {
              (next as Record<string, unknown>)[key] = value;
            }
          }
        }
        metadata.set(photoId, next);
      }
      return { updated: photoIds, failed: [] };
    },
    'metadata:expandCaption': async (...args) => {
      const { photoId, text } = args[0] as { photoId: PhotoId; text: string };
      return expandMockCaption(findPhoto(photoId), metadata.get(photoId) ?? {}, text);
    },
    'develop:getParams': async (...args) => {
      const { photoId, versionId } = args[0] as { photoId: PhotoId; versionId?: VersionId };
      return params.get(versionKey(photoId, versionId)) ?? {};
    },
    'develop:getDefaults': async () => ({}),
    'profiles:list': async () => ({ camera: '', profiles: [] }),
    'profiles:index': async () => ({ profiles: [], problems: [], folders: [] }),
    'profiles:resolve': async () => ({ status: 'none' }),
    'develop:setParams': async (...args) => {
      const {
        photoId,
        versionId,
        params: next,
      } = args[0] as {
        photoId: PhotoId;
        versionId?: VersionId;
        params: EditParams;
      };
      params.set(versionKey(photoId, versionId), next);
    },
    'develop:applySettings': async (...args) => {
      const {
        photoIds,
        params: source,
        groups,
      } = args[0] as {
        photoIds: PhotoId[];
        params: EditParams;
        groups: Parameters<typeof applyDevelopSettingGroups>[2];
      };
      return photoIds.map((photoId) => {
        const photo = findPhoto(photoId);
        const develop = photo.versions.find((version) => version.kind === 'develop');
        const key = versionKey(photoId, develop?.id);
        const next = applyDevelopSettingGroups(params.get(key) ?? {}, source, groups);
        params.set(key, next);
        if (develop?.kind === 'develop') develop.ops = next;
        photo.status.edited = Object.keys(next).some((name) => name !== 'ProcessVersion');
        return photo;
      });
    },
    'develop:listPresets': async () => presets,
    'develop:importPreset': async (...args) => {
      const { path } = args[0] as { path: string };
      return {
        ...presets[0],
        id: asPresetId('test-imported'),
        name: 'Imported preset',
        path,
        unsupported: ['LensProfile', 'Crop'],
      } as never;
    },
    'upload:list': async () => uploads,
    'upload:retry': async (...args) => {
      const { uploadId } = args[0] as { uploadId: UploadItem['id'] };
      const item = uploads.find((candidate) => candidate.id === uploadId);
      if (item) {
        item.state = 'queued';
        item.attempts += 1;
      }
    },
    'upload:cancel': async (...args) => {
      const { uploadId } = args[0] as { uploadId: UploadItem['id'] };
      const item = uploads.find((candidate) => candidate.id === uploadId);
      if (item) item.state = 'cancelled';
    },
    'exportPresets:list': async () => exportPresets,
    'exportPresets:save': async (...args) => {
      const { preset } = args[0] as { preset: ExportPreset };
      const index = exportPresets.findIndex((candidate) => candidate.id === preset.id);
      if (index >= 0)
        exportPresets = exportPresets.map((candidate) =>
          candidate.id === preset.id ? preset : candidate,
        );
      else exportPresets = [...exportPresets, preset];
      return preset;
    },
    'exportPresets:remove': async (...args) => {
      const { presetId } = args[0] as { presetId: ExportPreset['id'] };
      exportPresets = exportPresets.filter((preset) => preset.id !== presetId);
    },
    'export:start': async (...args) => {
      const { photoIds, presetId, send, forceTop } = args[0] as {
        photoIds: PhotoId[];
        presetId: ExportPreset['id'];
        send?: ExportPreset['sendTo'];
        forceTop?: boolean;
      };
      const preset = exportPresets.find((candidate) => candidate.id === presetId);
      if (!preset) throw new Error(`no export preset ${presetId}`);
      const job: ExportJob = {
        id: `test-export-${++exportSequence}` as ExportJob['id'],
        presetId,
        photoIds: [...photoIds],
        send: send ?? preset.sendTo,
        state: 'queued',
        version: forceTop === true || (send ?? preset.sendTo).length > 0 ? 'top' : preset.version,
        photos: photoIds.map((photoId) => ({ photoId, state: 'queued' })),
        createdAt: Date.now(),
      };
      exportJobs.unshift(job);
      const publish = (state: ExportJob['state']): void => {
        job.state = state;
        emit('jobs:event', {
          type: 'export.state',
          at: Date.now(),
          jobId: job.id,
          state,
          job: { ...job, photos: job.photos.map((photo) => ({ ...photo })) },
        });
      };
      const progress = (photoId: PhotoId): void =>
        emit('jobs:event', {
          type: 'export.progress',
          at: Date.now(),
          jobId: job.id,
          photoId,
          job: { ...job, photos: job.photos.map((photo) => ({ ...photo })) },
        });
      void (async () => {
        publish('running');
        for (const photo of job.photos) {
          if (job.state === 'cancelled') break;
          photo.state = 'rendering';
          progress(photo.photoId);
          const requestId = `render-${++exportRequestSequence}`;
          const outcome = new Promise<{ rendered?: unknown; error?: string }>((resolve) => {
            renderWaiters.set(requestId, resolve);
          });
          emit('jobs:event', {
            type: 'export.render',
            at: Date.now(),
            jobId: job.id,
            requestId,
            photoId: photo.photoId,
            presetId: job.presetId,
            version: preset.version,
          });
          const renderedOutcome = await outcome;
          renderWaiters.delete(requestId);
          if (renderedOutcome.error !== undefined || renderedOutcome.rendered === undefined) {
            photo.state = 'failed';
            photo.error = renderedOutcome.error ?? 'the renderer returned no image';
          } else {
            photo.state = 'done';
            photo.path = `/mock/exports/${photo.photoId}.jpg`;
          }
          progress(photo.photoId);
        }
        publish(
          job.state === 'cancelled'
            ? 'cancelled'
            : job.photos.some((photo) => photo.state === 'failed')
              ? 'failed'
              : 'done',
        );
      })();
      return job.id;
    },
    'export:cancel': async (...args) => {
      const { jobId } = args[0] as { jobId: ExportJob['id'] };
      const job = exportJobs.find((candidate) => candidate.id === jobId);
      if (job) job.state = 'cancelled';
    },
    'export:list': async () => exportJobs,
    'export:render': async (...args) => {
      const { requestId, rendered, error } = args[0] as {
        requestId: string;
        rendered?: unknown;
        error?: string;
      };
      renderWaiters.get(requestId)?.({ rendered, error });
    },
    'export:rendererReady': async () => {},
    'settings:get': async () => settings,
    'settings:set': async (...args) => {
      const patch = args[0] as Partial<typeof settings>;
      settings = { ...settings, ...patch };
      return settings;
    },
    'credentials:set': async (...args) => {
      const { ref } = args[0] as { ref?: string };
      return { ref: ref || 'test-credential' };
    },
    'credentials:remove': async () => {},
    'dialog:pick': async () => ['/mock/preset.xmp'],
    'retouch:get': async (...args) => {
      const { photoId, versionId } = args[0] as { photoId: PhotoId; versionId?: VersionId };
      const photo = findPhoto(photoId);
      const version =
        photo.versions.find((candidate) => candidate.id === versionId) ??
        photo.versions.filter((candidate) => candidate.kind === 'retouch').at(-1);
      return version?.kind === 'retouch' ? version.ops : [];
    },
    'retouch:set': async (...args) => {
      const { photoId, versionId, ops } = args[0] as {
        photoId: PhotoId;
        versionId?: VersionId;
        ops: Photo['versions'][number]['ops'];
      };
      const photo = findPhoto(photoId);
      const version = photo.versions.find(
        (candidate) => candidate.kind === 'retouch' && candidate.id === versionId,
      );
      if (version?.kind !== 'retouch') throw new Error(`no retouch version ${versionId}`);
      version.ops = ops as typeof version.ops;
    },
    'retouch:detectFaces': async () => [],
  };

  const handlers = { ...defaults, ...options.handlers };

  const transport: BridgeTransport = {
    invoke: async (channel, args) => {
      calls.push({ channel, args });
      const handler = handlers[channel];
      if (!handler) return { ok: true, value: undefined };
      return toIpcResult(() => handler(...args));
    },
    subscribe: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
  };

  return {
    bridge: createBridge(transport),
    transport,
    calls,
    emit,
    uploads,
    get settings() {
      return settings;
    },
    get exportPresets() {
      return exportPresets;
    },
  };
}
