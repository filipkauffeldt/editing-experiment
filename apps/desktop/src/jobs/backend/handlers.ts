import { IpcError, type IpcHandlers } from '@ee/contracts';
import { isRawPath } from '@ee/metadata';
import { testSource, type GetSecret } from '@ee/ingest';
import type { CardScanner } from '@ee/ingest';
import type { UploadQueue } from '@ee/export';
import { systemHandlers } from '../handlers/system';
import type { Emit, PhotoLibrary } from './photo-library';
import type { EditService } from './edit-service';
import type { EditedPreviews } from './edited-previews';
import type { ExportQueue } from './export-queue';
import type { ExportService } from './export-service';
import type { FaceService } from './faces';
import type { FolderImportService } from './folder-import';
import type { IngestService } from './ingest-service';
import type { LabelService } from './label-service';
import type { MetadataService } from './metadata-service';
import type { PhotoDeleter } from './photo-deleter';
import type { RotateService } from './rotate-service';
import type { DiskCache } from './disk-cache';
import type { SearchIndex } from './search-index';
import type { PresetLibrary } from './preset-library';
import type { PresetStore } from './presets';
import type { ProfileLibrary } from './profiles';
import type { SettingsStore } from './settings-store';

export interface HandlerDeps {
  appVersion: string;
  emit: Emit;
  getSecret: GetSecret;
  photos: PhotoLibrary;
  search: SearchIndex;
  deleter: PhotoDeleter;
  settings: SettingsStore;
  metadata: MetadataService;
  edits: EditService;
  editedPreviews: EditedPreviews;
  labels: LabelService;
  rotator: RotateService;
  faces: FaceService;
  presets: PresetStore;
  presetLibrary: PresetLibrary;
  profiles: ProfileLibrary;
  ingest: IngestService;
  /** One scanner for the app's life, shared with added-folder validation. */
  cards: CardScanner;
  folders: FolderImportService;
  queue: UploadQueue;
  exports: ExportQueue;
  exporter: ExportService;
  cache: DiskCache;
}

/** One handler per channel the jobs process serves in real mode. */
export function createBackendHandlers(deps: HandlerDeps): IpcHandlers {
  const { photos, settings, metadata, edits, editedPreviews, labels, faces, presets, ingest } =
    deps;
  const { profiles, presetLibrary } = deps;
  const { queue, exports } = deps;
  const servedByMain = (channel: string) => async (): Promise<never> => {
    throw new IpcError('internal', `${channel} is served by the main process`);
  };

  return {
    ...systemHandlers({ mock: false, appVersion: deps.appVersion, emit: deps.emit }),

    'photos:list': async (args) =>
      args?.folder === undefined ? photos.list(args?.sourceId) : photos.listFolder(args.folder),
    'photos:folders': async () => photos.overview(),
    'photos:query': async (args) => {
      const search = args?.filter?.search?.trim() ?? '';
      const found = search === '' ? undefined : deps.search.search(search).photoIds;
      const result = photos.query({
        ...(args?.folder === undefined ? {} : { folder: args.folder }),
        ...(args?.filter === undefined ? {} : { filter: args.filter }),
        ...(args?.sort === undefined ? {} : { sort: args.sort }),
        ...(args?.offset === undefined ? {} : { offset: args.offset }),
        ...(args?.limit === undefined ? {} : { limit: args.limit }),
        ...(args?.anchorId === undefined ? {} : { anchorId: args.anchorId }),
        ...(args?.fromEnd === true ? { fromEnd: true } : {}),
        ...(found === undefined ? {} : { ids: new Set(found) }),
      });
      return result;
    },
    'photos:facets': async (args) => {
      const search = args?.filter?.search?.trim() ?? '';
      const found = search === '' ? undefined : deps.search.search(search).photoIds;
      return photos.facets({
        ...(args?.folder === undefined ? {} : { folder: args.folder }),
        ...(args?.filter === undefined ? {} : { filter: args.filter }),
        ...(args?.sort === undefined ? {} : { sort: args.sort }),
        ...(found === undefined ? {} : { ids: new Set(found) }),
      });
    },
    'photos:get': async ({ photoId }) => photos.get(photoId),
    'photos:search': async ({ query }) => deps.search.search(query),
    'photos:createVersion': (args) => edits.createVersion(args),
    'photos:deleteVersion': (args) => edits.deleteVersion(args),
    'photos:setLabels': (args) => labels.setLabels(args),
    'photos:delete': (args) => deps.deleter.delete(args),
    'photos:removeFromLibrary': (args) => deps.deleter.removeFromLibrary(args),
    'photos:addFolder': ({ path }) => deps.folders.addFolder(path),
    'photos:rescanFolder': ({ path }) => deps.folders.rescanFolder(path),
    'photos:stopFolderImport': async ({ jobId }) => deps.folders.stop(jobId),
    'photos:removeFolder': (args) => deps.deleter.removeFolder(args),
    'photos:listAddedFolders': async () => photos.addedFolders(),
    'photos:setEditedPreview': async (args) => editedPreviews.set(args),
    'photos:shiftCaptureTime': (args) => metadata.shiftCaptureTime(args),
    'photos:rotate': (args) => deps.rotator.rotate(args),

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
    'sources:detectCards': (args) => deps.cards.scan(args),

    'destinations:list': async () => settings.listDestinations(),
    'destinations:save': async ({ destination }) => settings.saveDestination(destination),
    'destinations:remove': async ({ destinationId }) => settings.removeDestination(destinationId),
    'destinations:test': ({ destination }) => queue.testDestination(destination),

    // Served by the main process (`safeStorage`, native dialogs); present to satisfy the type.
    'credentials:set': servedByMain('credentials:set'),
    'credentials:remove': servedByMain('credentials:remove'),
    'credentials:present': servedByMain('credentials:present'),

    'metadata:read': ({ photoId }) => metadata.read(photoId),
    'metadata:write': (args) => metadata.write(args),
    'metadata:readTemplate': ({ path }) => metadata.readTemplate(path),
    'metadata:applyTemplate': (args) => metadata.applyTemplate(args),
    'metadata:writeFields': (args) => metadata.writeFields(args),
    'metadata:expandCaption': (args) => metadata.expandCaption(args),
    'metadata:codeReplacementFiles': () => metadata.codeReplacementFiles(),

    'develop:getParams': (ref) => edits.getParams(ref),
    'develop:getDefaults': async ({ photoId }) => edits.getDefaults(photoId),
    'develop:setParams': (args) => edits.setParams(args),
    'develop:applySettings': (args) => edits.applySettings(args),
    'develop:presetIndex': (args) => presetLibrary.index(args?.rescan === true),
    'develop:importPreset': async ({ path }) => {
      const imported = await presets.import(path);
      // The list the library holds has to include it from now on.
      await presetLibrary.index(true);
      return imported;
    },

    // Camera profiles describe a raw sensor; a JPEG or TIFF is already rendered and has none.
    'profiles:list': async ({ photoId }) => {
      const photo = photos.get(photoId);
      return isRawPath(photo.path) ? profiles.list(photo.camera) : { camera: '', profiles: [] };
    },
    'profiles:index': async (args) => profiles.index(args?.rescan === true),
    'profiles:resolve': async (args) => {
      const photo = photos.get(args.photoId);
      return profiles.resolveFor(args, photo);
    },

    'retouch:get': (ref) => edits.getRetouch(ref),
    'retouch:set': (args) => edits.setRetouch(args),
    'retouch:detectFaces': (args) => faces.detect(args),

    'exportPresets:list': async () => settings.listExportPresets(),
    'exportPresets:save': async ({ preset }) => settings.saveExportPreset(preset),
    'exportPresets:remove': async ({ presetId }) => settings.removeExportPreset(presetId),

    'export:start': async (args) => exports.start(args),
    'export:previewTarget': (args) => deps.exporter.previewTarget(args),
    'export:cancel': async ({ jobId }) => exports.cancel(jobId),
    'export:list': async () => exports.list(),
    'export:render': async (args) => exports.deliverRender(args),
    'export:rendererReady': async () => exports.markRendererReady(),

    'upload:list': async () => queue.list(),
    'upload:retry': async ({ uploadId }) => queue.retry(uploadId),
    'upload:cancel': async ({ uploadId }) => queue.cancel(uploadId),

    'cache:stats': async () => deps.cache.stats(),
    'cache:setLimit': async ({ limitBytes }) => {
      if (!Number.isInteger(limitBytes) || limitBytes < 0) {
        throw new IpcError('invalid_argument', 'the cache limit must be a whole number of bytes');
      }
      settings.set({ cacheLimitBytes: limitBytes });
      await deps.cache.setLimit(limitBytes);
      return deps.cache.stats();
    },
    'cache:clear': async () => {
      await deps.cache.clear();
      return deps.cache.stats();
    },

    'settings:get': async () => settings.get(),
    'settings:set': async (patch) => settings.set(patch),
    'settings:folder': async () => settings.folderInfo(),
    'settings:inspectFolder': async ({ path }) => settings.inspectFolder(path),
    'settings:useFolder': async ({ path }) => {
      const info = settings.useFolder(path);
      await presetLibrary.index(true).catch(() => undefined);
      return info;
    },
    'settings:copyToFolder': async ({ path }) => {
      const info = settings.copyToFolder(path);
      await presetLibrary.index(true).catch(() => undefined);
      return info;
    },

    'dialog:pick': servedByMain('dialog:pick'),
  };
}
