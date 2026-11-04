import { IpcError, type IpcHandlers } from '@ee/contracts';
import { isRawPath } from '@ee/metadata';
import { delimiter } from 'node:path';
import { CardScanner, testSource, type GetSecret } from '@ee/ingest';
import type { UploadQueue } from '@ee/export';
import { systemHandlers } from '../handlers/system';
import type { Emit, PhotoLibrary } from './photo-library';
import type { EditService } from './edit-service';
import type { EditedPreviews } from './edited-previews';
import type { ExportQueue } from './export-queue';
import type { FaceService } from './faces';
import type { IngestService } from './ingest-service';
import type { LabelService } from './label-service';
import type { MetadataService } from './metadata-service';
import type { PresetStore } from './presets';
import type { ProfileLibrary } from './profiles';
import type { SettingsStore } from './settings-store';

export interface HandlerDeps {
  appVersion: string;
  emit: Emit;
  getSecret: GetSecret;
  photos: PhotoLibrary;
  settings: SettingsStore;
  metadata: MetadataService;
  edits: EditService;
  editedPreviews: EditedPreviews;
  labels: LabelService;
  faces: FaceService;
  presets: PresetStore;
  profiles: ProfileLibrary;
  ingest: IngestService;
  queue: UploadQueue;
  exports: ExportQueue;
}

/**
 * `EE_CARD_ROOTS` replaces the folders that are scanned for cards (separated like
 * `PATH`). It exists so end-to-end tests can mount a card in a temp folder; the app
 * never sets it.
 */
function cardScannerFromEnv(env: NodeJS.ProcessEnv): CardScanner {
  const roots = env.EE_CARD_ROOTS?.split(delimiter).filter((root) => root !== '');
  return new CardScanner(roots && roots.length > 0 ? { mountRoots: roots } : {});
}

/** One handler per channel the jobs process serves in real mode. */
export function createBackendHandlers(deps: HandlerDeps): IpcHandlers {
  const { photos, settings, metadata, edits, editedPreviews, labels, faces, presets, ingest } =
    deps;
  const { profiles } = deps;
  const { queue, exports } = deps;
  const servedByMain = (channel: string) => async (): Promise<never> => {
    throw new IpcError('internal', `${channel} is served by the main process`);
  };

  // One scanner for the app's life: it remembers the cards it found and their counts, so a scan
  // that times out on a slow reader does not forget a card.
  const cards = cardScannerFromEnv(process.env);

  return {
    ...systemHandlers({ mock: false, appVersion: deps.appVersion, emit: deps.emit }),

    'photos:list': async (args) => photos.list(args?.sourceId),
    'photos:get': async ({ photoId }) => photos.get(photoId),
    'photos:createVersion': (args) => edits.createVersion(args),
    'photos:deleteVersion': (args) => edits.deleteVersion(args),
    'photos:setLabels': (args) => labels.setLabels(args),
    'photos:setEditedPreview': async (args) => editedPreviews.set(args),

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
    'sources:detectCards': (args) => cards.scan(args),

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
    'metadata:writeFields': (args) => metadata.writeFields(args),
    'metadata:expandCaption': (args) => metadata.expandCaption(args),

    'develop:getParams': (ref) => edits.getParams(ref),
    'develop:getDefaults': ({ photoId }) => edits.getDefaults(photoId),
    'develop:setParams': (args) => edits.setParams(args),
    'develop:applySettings': (args) => edits.applySettings(args),
    'develop:listPresets': () => presets.list(),
    'develop:importPreset': ({ path }) => presets.import(path),

    // Camera profiles describe a raw sensor; a JPEG or TIFF is already rendered and has none.
    'profiles:list': async ({ photoId }) => {
      const photo = photos.get(photoId);
      return isRawPath(photo.path) ? profiles.list(photo.camera) : { camera: '', profiles: [] };
    },
    'profiles:index': async (args) => profiles.index(args?.rescan === true),
    'profiles:resolve': async (args) => {
      const photo = photos.get(args.photoId);
      return isRawPath(photo.path) ? profiles.resolve(args, photo.camera) : { status: 'none' };
    },

    'retouch:get': (ref) => edits.getRetouch(ref),
    'retouch:set': (args) => edits.setRetouch(args),
    'retouch:detectFaces': (args) => faces.detect(args),

    'exportPresets:list': async () => settings.listExportPresets(),
    'exportPresets:save': async ({ preset }) => settings.saveExportPreset(preset),
    'exportPresets:remove': async ({ presetId }) => settings.removeExportPreset(presetId),

    'export:start': async (args) => exports.start(args),
    'export:cancel': async ({ jobId }) => exports.cancel(jobId),
    'export:list': async () => exports.list(),
    'export:render': async (args) => exports.deliverRender(args),
    'export:rendererReady': async () => exports.markRendererReady(),

    'upload:list': async () => queue.list(),
    'upload:retry': async ({ uploadId }) => queue.retry(uploadId),
    'upload:cancel': async ({ uploadId }) => queue.cancel(uploadId),

    'settings:get': async () => settings.get(),
    'settings:set': async (patch) => settings.set(patch),

    'dialog:pick': servedByMain('dialog:pick'),
  };
}
