import { IpcError, type IpcHandlers } from '@ee/contracts';
import { detectCards, testSource, type GetSecret } from '@ee/ingest';
import type { UploadQueue } from '@ee/export';
import { systemHandlers } from '../handlers/system';
import type { Emit, PhotoLibrary } from './photo-library';
import type { EditService } from './edit-service';
import type { ExportService } from './export-service';
import type { FaceService } from './faces';
import type { IngestService } from './ingest-service';
import type { MetadataService } from './metadata-service';
import type { PresetStore } from './presets';
import type { SettingsStore } from './settings-store';

export interface HandlerDeps {
  appVersion: string;
  emit: Emit;
  getSecret: GetSecret;
  photos: PhotoLibrary;
  settings: SettingsStore;
  metadata: MetadataService;
  edits: EditService;
  faces: FaceService;
  presets: PresetStore;
  ingest: IngestService;
  queue: UploadQueue;
  exporter: ExportService;
}

/** One handler per channel the jobs process serves in real mode. */
export function createBackendHandlers(deps: HandlerDeps): IpcHandlers {
  const { photos, settings, metadata, edits, faces, presets, ingest, queue, exporter } = deps;
  const servedByMain = (channel: string) => async (): Promise<never> => {
    throw new IpcError('internal', `${channel} is served by the main process`);
  };

  return {
    ...systemHandlers({ mock: false, appVersion: deps.appVersion, emit: deps.emit }),

    'photos:list': async (args) => photos.list(args?.sourceId),
    'photos:get': async ({ photoId }) => photos.get(photoId),
    'photos:createVersion': (args) => edits.createVersion(args),

    'ingest:start': ({ config }) => ingest.start(config),
    'ingest:stop': async (args) => ingest.stop(args?.sourceId),
    'ingest:status': async () => ingest.status(),

    'sources:list': async () => settings.listSources(),
    'sources:save': async ({ source }) => settings.saveSource(source),
    'sources:remove': async ({ sourceId }) => {
      await ingest.stop(sourceId);
      settings.removeSource(sourceId);
    },
    'sources:test': ({ source }) => testSource(source, { getSecret: deps.getSecret }),
    'sources:detectCards': () => detectCards(),

    'destinations:list': async () => settings.listDestinations(),
    'destinations:save': async ({ destination }) => settings.saveDestination(destination),
    'destinations:remove': async ({ destinationId }) => settings.removeDestination(destinationId),
    'destinations:test': ({ destination }) => queue.testDestination(destination),

    // Served by the main process (`safeStorage`, native dialogs); present to satisfy the type.
    'credentials:set': servedByMain('credentials:set'),
    'credentials:remove': servedByMain('credentials:remove'),

    'metadata:read': ({ photoId }) => metadata.read(photoId),
    'metadata:write': (args) => metadata.write(args),
    'metadata:readTemplate': ({ path }) => metadata.readTemplate(path),
    'metadata:applyTemplate': (args) => metadata.applyTemplate(args),
    'metadata:expandCaption': (args) => metadata.expandCaption(args),

    'develop:getParams': (ref) => edits.getParams(ref),
    'develop:setParams': (args) => edits.setParams(args),
    'develop:listPresets': () => presets.list(),
    'develop:importPreset': ({ path }) => presets.import(path),

    'retouch:get': (ref) => edits.getRetouch(ref),
    'retouch:set': (args) => edits.setRetouch(args),
    'retouch:detectFaces': (args) => faces.detect(args),

    'export:photo': (args) => exporter.export(args),

    'upload:list': async () => queue.list(),
    'upload:retry': async ({ uploadId }) => queue.retry(uploadId),
    'upload:cancel': async ({ uploadId }) => queue.cancel(uploadId),

    'settings:get': async () => settings.get(),
    'settings:set': async (patch) => settings.set(patch),

    'dialog:pick': servedByMain('dialog:pick'),
  };
}
