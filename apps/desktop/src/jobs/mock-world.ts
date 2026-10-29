import {
  IPTC_FIELD_NAMES,
  asExportJobId,
  asJobId,
  asPresetId,
  asVersionId,
  type Destination,
  type EditParams,
  type EditPreset,
  type EventChannel,
  type ExportJob,
  type ExportPreset,
  type IngestJobInfo,
  type IpcHandlers,
  type IptcFields,
  type JobEvent,
  type Photo,
  type RetouchOp,
  type PhotoId,
  type PresetId,
  type SourceConfig,
  type SourceId,
  type UploadItem,
  type UploadItemState,
  type VersionId,
} from '@ee/contracts';
import {
  expandMockCaption,
  mockDestinations,
  mockEditParams,
  mockMetadata,
  mockPhotos,
  mockPresets,
  mockSettings,
  mockSources,
  mockTemplate,
  mockUploads,
  MOCK_TEMPLATE_PATH,
} from '../shared/mock';

type Emit = (channel: EventChannel, payload: unknown) => void;

/** Mutable in-memory backend used only by `EE_MOCK=1`. */
export interface MockWorld {
  photos: Photo[];
  metadata: Map<PhotoId, IptcFields>;
  params: Map<string, EditParams>;
  retouch: Map<string, RetouchOp[]>;
  uploads: UploadItem[];
  ingest: Map<SourceId, IngestJobInfo>;
  sources: SourceConfig[];
  destinations: Destination[];
  presets: EditPreset[];
  exportPresets: ExportPreset[];
  exportJobs: ExportJob[];
  activePresetId?: PresetId;
  template: IptcFields;
  templatePath: string;
}

const versionKey = (photoId: PhotoId, versionId: VersionId | undefined): string =>
  `${photoId}:${versionId ?? 'active'}`;

const fieldsEqual = (left: IptcFields, right: IptcFields): boolean =>
  IPTC_FIELD_NAMES.every((name) => {
    const a = left[name];
    const b = right[name];
    if (Array.isArray(a) || Array.isArray(b)) {
      return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
    }
    return (a ?? '') === (b ?? '');
  });

const emitPhoto = (world: MockWorld, emit: Emit, photo: Photo): void => {
  emit('photos:updated', photo);
};

const emitEvent = (emit: Emit, event: JobEvent): void => {
  emit('jobs:event', event);
};

const photoById = (world: MockWorld, photoId: PhotoId): Photo | undefined =>
  world.photos.find((photo) => photo.id === photoId);

const updateUpload = (
  world: MockWorld,
  emit: Emit,
  item: UploadItem,
  state: UploadItemState,
  error?: string,
): void => {
  item.state = state;
  item.error = error;
  if (state === 'done') item.bytesSent = item.bytesTotal;
  const photo = photoById(world, item.photoId);
  if (photo) {
    photo.status.upload = state === 'cancelled' ? 'none' : state;
    if (state === 'done') photo.status.export = 'done';
    emitPhoto(world, emit, photo);
  }
  emitEvent(emit, {
    type: 'upload.state',
    at: Date.now(),
    uploadId: item.id,
    photoId: item.photoId,
    destinationId: item.destinationId,
    state,
    error,
  });
};

function startSimulation(world: MockWorld, emit: Emit): void {
  setInterval(() => {
    for (const [sourceId, info] of world.ingest) {
      if (info.state !== 'running') continue;
      info.filesDone = Math.min(info.filesTotal, info.filesDone + 1);
      info.bytesDone = Math.round((info.filesDone / Math.max(1, info.filesTotal)) * 380_000_000);
      emitEvent(emit, {
        type: 'ingest.progress',
        at: Date.now(),
        jobId: info.jobId,
        sourceId,
        filesTotal: info.filesTotal,
        filesDone: info.filesDone,
        bytesDone: info.bytesDone,
        currentFile: `_DSC${8330 + info.filesDone}.NEF`,
      });
      if (info.filesDone >= info.filesTotal) {
        info.state = 'finished';
        emitEvent(emit, {
          type: 'ingest.state',
          at: Date.now(),
          jobId: info.jobId,
          sourceId,
          state: 'finished',
        });
      }
    }
  }, 1600);

  setInterval(() => {
    const item =
      world.uploads.find((candidate) => candidate.state === 'uploading') ??
      world.uploads.find((candidate) => candidate.state === 'queued');
    if (!item) return;
    if (item.state === 'uploading') {
      updateUpload(world, emit, item, 'done');
    } else {
      updateUpload(world, emit, item, 'uploading');
    }
  }, 2600);
}

/** Build the mock backend state. `simulate` sends progress events on a timer. */
export function createMockWorld(emit: Emit, simulate: boolean): MockWorld {
  const photos = mockPhotos();
  const metadata = new Map<PhotoId, IptcFields>();
  const params = new Map<string, EditParams>();
  const retouch = new Map<string, RetouchOp[]>();
  for (const [index, photo] of photos.entries()) {
    metadata.set(photo.id, mockMetadata(index + 1));
    const develop = photo.versions.find((version) => version.kind === 'develop');
    params.set(versionKey(photo.id, develop?.id), mockEditParams(index + 1));
    const version = photo.versions.find((candidate) => candidate.kind === 'retouch');
    if (version) retouch.set(versionKey(photo.id, version.id), version.ops);
  }
  const ingest = new Map<SourceId, IngestJobInfo>();
  const sources = mockSources();
  sources.forEach((source, index) => {
    ingest.set(source.id, {
      jobId: asJobId(`mock-ingest-${index + 1}`),
      sourceId: source.id,
      state: 'running',
      filesTotal: 20,
      filesDone: index === 0 ? 14 : 8,
      bytesDone: index === 0 ? 190_000_000 : 72_000_000,
    });
  });
  const world: MockWorld = {
    photos,
    metadata,
    params,
    retouch,
    uploads: mockUploads(),
    ingest,
    sources,
    destinations: mockDestinations(),
    presets: mockPresets(),
    exportPresets: mockSettings().exportPresets,
    exportJobs: [],
    activePresetId: mockSettings().activePresetId,
    template: mockTemplate(),
    templatePath: MOCK_TEMPLATE_PATH,
  };
  if (simulate) startSimulation(world, emit);
  return world;
}

/** Ingest, metadata, develop, upload and export handlers backed by {@link MockWorld}. */
export function createMockHandlers(world: MockWorld, emit: Emit): Partial<IpcHandlers> {
  const findPhoto = (photoId: PhotoId): Photo => {
    const photo = photoById(world, photoId);
    if (!photo) throw new Error(`no photo ${photoId}`);
    return photo;
  };

  const applyMetadata = (photo: Photo, fields: IptcFields): Photo => {
    photo.status.metadataDiffersFromTemplate = !fieldsEqual(fields, world.template);
    emitPhoto(world, emit, photo);
    return photo;
  };

  return {
    // --- ingest ---
    'ingest:start': async ({ config }) => {
      const started: IngestJobInfo[] = [];
      for (const source of config.sources) {
        const info: IngestJobInfo = {
          jobId: asJobId(`mock-ingest-${Date.now()}-${started.length}`),
          sourceId: source.id,
          state: 'running',
          filesTotal: world.photos.filter((photo) => photo.sourceId === source.id).length || 20,
          filesDone: 0,
          bytesDone: 0,
        };
        world.ingest.set(source.id, info);
        started.push(info);
        emitEvent(emit, {
          type: 'ingest.state',
          at: Date.now(),
          jobId: info.jobId,
          sourceId: source.id,
          state: 'running',
        });
      }
      return started;
    },
    'ingest:stop': async ({ sourceId } = {}) => {
      for (const [id, info] of world.ingest) {
        if (sourceId && id !== sourceId) continue;
        info.state = 'stopped';
        emitEvent(emit, {
          type: 'ingest.state',
          at: Date.now(),
          jobId: info.jobId,
          sourceId: id,
          state: 'stopped',
        });
      }
    },
    'ingest:status': async () => [...world.ingest.values()],

    // --- sources & destinations ---
    'sources:list': async () => world.sources,
    'sources:save': async ({ source }) => {
      const index = world.sources.findIndex((candidate) => candidate.id === source.id);
      if (index >= 0) world.sources[index] = source;
      else world.sources.push(source);
      return source;
    },
    'sources:remove': async ({ sourceId }) => {
      world.sources = world.sources.filter((source) => source.id !== sourceId);
    },
    'sources:test': async ({ source }) => ({
      ok: true,
      message:
        source.kind === 'folder' || source.kind === 'card'
          ? `Found ${world.photos.length} images`
          : `Connected to ${source.host}:${source.port} (mock)`,
    }),
    'sources:detectCards': async () => [
      { mountPath: '/mock/cards/NIKON_Z9', volumeLabel: 'NIKON_Z9', imageCount: 20 },
    ],
    'destinations:list': async () => world.destinations,
    'destinations:save': async ({ destination }) => {
      const index = world.destinations.findIndex((candidate) => candidate.id === destination.id);
      if (index >= 0) world.destinations[index] = destination;
      else world.destinations.push(destination);
      return destination;
    },
    'destinations:remove': async ({ destinationId }) => {
      world.destinations = world.destinations.filter(
        (destination) => destination.id !== destinationId,
      );
    },
    'destinations:test': async ({ destination }) => ({
      ok: true,
      message:
        destination.kind === 'folder'
          ? 'Folder is writable (mock)'
          : `Connected to ${destination.host}:${destination.port} (mock)`,
    }),

    // --- metadata ---
    'metadata:read': async ({ photoId }) => {
      findPhoto(photoId);
      return world.metadata.get(photoId) ?? {};
    },
    'metadata:write': async ({ photoId, fields }) => {
      const photo = findPhoto(photoId);
      const merged = { ...(world.metadata.get(photoId) ?? {}), ...fields };
      world.metadata.set(photoId, merged);
      return applyMetadata(photo, merged);
    },
    'metadata:readTemplate': async () => ({ ...world.template }),
    'metadata:applyTemplate': async ({ photoIds, mode }) => {
      const updated: PhotoId[] = [];
      const failed: { photoId: PhotoId; message: string }[] = [];
      for (const photoId of photoIds) {
        const photo = photoById(world, photoId);
        if (!photo) {
          failed.push({ photoId, message: 'no such photo' });
          continue;
        }
        const current = world.metadata.get(photoId) ?? {};
        const next: IptcFields = { ...current };
        for (const name of IPTC_FIELD_NAMES) {
          const templateValue = world.template[name];
          if (templateValue === undefined) continue;
          const currentValue = current[name];
          const empty =
            currentValue === undefined ||
            (Array.isArray(currentValue) ? currentValue.length === 0 : currentValue === '');
          if (mode === 'replace' || empty) {
            (next as Record<string, unknown>)[name] = templateValue;
          }
        }
        world.metadata.set(photoId, next);
        applyMetadata(photo, next);
        updated.push(photoId);
      }
      return { updated, failed };
    },
    'metadata:expandCaption': async ({ photoId, text }) => {
      const photo = findPhoto(photoId);
      return expandMockCaption(photo, world.metadata.get(photoId) ?? {}, text);
    },

    // --- develop ---
    'develop:getParams': async ({ photoId, versionId }) => {
      const photo = findPhoto(photoId);
      const develop = photo.versions.find((version) => version.kind === 'develop');
      return world.params.get(versionKey(photoId, versionId ?? develop?.id)) ?? {};
    },
    'develop:setParams': async ({ photoId, versionId, params }) => {
      findPhoto(photoId);
      world.params.set(versionKey(photoId, versionId), { ...params });
    },
    'develop:listPresets': async () => world.presets,
    'develop:importPreset': async ({ path }) => {
      const name =
        path
          .split('/')
          .pop()
          ?.replace(/\.xmp$/i, '') ?? 'Imported preset';
      const imported = {
        id: asPresetId(`mock-preset-imported-${world.presets.length + 1}`),
        name,
        path,
        params: { Exposure2012: 0.15, Contrast2012: 10, Vibrance: 8 },
        // The contracts do not have this field yet; the UI reads it defensively.
        unsupported: ['LensProfile', 'Crop'],
      };
      world.presets = [...world.presets, imported];
      return imported;
    },

    // --- retouch ---
    'retouch:get': async ({ photoId, versionId }) =>
      world.retouch.get(versionKey(photoId, versionId)) ?? [],
    'retouch:set': async ({ photoId, versionId, ops }) => {
      world.retouch.set(versionKey(photoId, versionId), ops);
    },
    'retouch:detectFaces': async ({ region }) => {
      const box = region ?? { type: 'rect' as const, x: 0.3, y: 0.3, w: 0.2, h: 0.2 };
      return [{ box, score: 0.94 }];
    },

    // --- export presets & jobs ---
    'exportPresets:list': async () => world.exportPresets,
    'exportPresets:save': async ({ preset }) => {
      const index = world.exportPresets.findIndex((candidate) => candidate.id === preset.id);
      if (index >= 0) world.exportPresets[index] = preset;
      else world.exportPresets.push(preset);
      return preset;
    },
    'exportPresets:remove': async ({ presetId }) => {
      world.exportPresets = world.exportPresets.filter((preset) => preset.id !== presetId);
    },
    'export:start': async ({ photoIds, presetId, send, forceTop }) => {
      const preset = world.exportPresets.find((candidate) => candidate.id === presetId);
      if (!preset) throw new Error(`no export preset ${presetId}`);
      const job: ExportJob = {
        id: asExportJobId(`mock-export-${Date.now()}-${world.exportJobs.length}`),
        presetId,
        photoIds: [...photoIds],
        send: send ?? preset.sendTo,
        state: 'queued',
        version:
          forceTop === true || (send ?? preset.sendTo).length > 0 ? 'top' : preset.version,
        photos: photoIds.map((photoId) => ({ photoId, state: 'queued' })),
        createdAt: Date.now(),
      };
      world.exportJobs.unshift(job);
      emitEvent(emit, {
        type: 'export.state',
        at: Date.now(),
        jobId: job.id,
        state: 'queued',
        job: { ...job, photos: job.photos.map((photo) => ({ ...photo })) },
      });
      setTimeout(() => {
        job.state = 'done';
        job.finishedAt = Date.now();
        for (const progress of job.photos) {
          progress.state = 'done';
          const photo = photoById(world, progress.photoId);
          if (photo) {
            photo.status.export = 'done';
            emitPhoto(world, emit, photo);
          }
        }
        emitEvent(emit, {
          type: 'export.state',
          at: Date.now(),
          jobId: job.id,
          state: job.state,
          job: { ...job, photos: job.photos.map((photo) => ({ ...photo })) },
        });
      }, 350);
      return job.id;
    },
    'export:cancel': async ({ jobId }) => {
      const job = world.exportJobs.find((candidate) => candidate.id === jobId);
      if (!job) return;
      job.state = 'cancelled';
      for (const photo of job.photos) photo.state = 'cancelled';
      emitEvent(emit, {
        type: 'export.state',
        at: Date.now(),
        jobId: job.id,
        state: job.state,
        job: { ...job, photos: job.photos.map((photo) => ({ ...photo })) },
      });
    },
    'export:list': async () => world.exportJobs,
    'export:render': async () => {},
    'export:rendererReady': async () => {},
    'upload:list': async () => world.uploads,
    'upload:retry': async ({ uploadId }) => {
      const item = world.uploads.find((candidate) => candidate.id === uploadId);
      if (!item) return;
      item.attempts += 1;
      updateUpload(world, emit, item, 'queued');
    },
    'upload:cancel': async ({ uploadId }) => {
      const item = world.uploads.find((candidate) => candidate.id === uploadId);
      if (!item) return;
      updateUpload(world, emit, item, 'cancelled');
    },

    'photos:setLabels': async ({ photoIds, tagged, colorClass }) => {
      const updated: Photo[] = [];
      for (const photoId of photoIds) {
        const photo = findPhoto(photoId);
        if (tagged !== undefined) photo.tagged = tagged;
        if (colorClass !== undefined) photo.colorClass = colorClass;
        emitPhoto(world, emit, photo);
        updated.push(photo);
      }
      return updated;
    },
    // Mock images are generated SVGs, so there is nothing to cache; accept and ignore.
    'photos:setEditedPreview': async ({ photoId }) => findPhoto(photoId),
    'photos:deleteVersion': async ({ photoId, versionId }) => {
      const photo = findPhoto(photoId);
      const version = photo.versions.find((candidate) => candidate.id === versionId);
      if (!version) throw new Error(`no version ${versionId}`);
      if (version.kind === 'develop') throw new Error('the develop version cannot be deleted');
      photo.versions = photo.versions.filter((candidate) => candidate.id !== versionId);
      emitPhoto(world, emit, photo);
      return photo;
    },

    // --- photos: versions (list/get live in photos.ts) ---
    'photos:createVersion': async ({ photoId, kind, name }) => {
      const photo = findPhoto(photoId);
      const version =
        kind === 'develop'
          ? { id: asVersionId(`mock-${photoId}-${Date.now()}`), kind, name, ops: {} }
          : { id: asVersionId(`mock-${photoId}-${Date.now()}`), kind, name, ops: [] };
      photo.versions = [...photo.versions, version as Photo['versions'][number]];
      emitPhoto(world, emit, photo);
      return version as Photo['versions'][number];
    },
  };
}
