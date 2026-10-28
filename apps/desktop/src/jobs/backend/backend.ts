import type { IpcHandlers, JobEvent, JobId, TemplateApplyMode } from '@ee/contracts';
import { SqliteSeenStore, type GetSecret } from '@ee/ingest';
import { UploadQueue, type UploadQueueOptions } from '@ee/export';
import { ExifToolService } from '@ee/metadata';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import {
  defaultSettings,
  DEFAULT_TEMPLATE_MODE,
  type BackendIngestSettings,
} from '../../shared/settings';
import type { AppBackendResponse } from '../../shared/jobs-protocol';
import { AppResources } from './app-resources';
import { EditService } from './edit-service';
import { withIpcErrors } from './errors';
import { FaceService, findYuNetModel } from './faces';
import { createBackendHandlers } from './handlers';
import { createOnFileIngested } from './ingest-pipeline';
import { IngestService } from './ingest-service';
import { userDataLayout, type UserDataLayout } from './layout';
import { MetadataService } from './metadata-service';
import { PhotoIndex } from './photo-index';
import { PhotoLibrary, type Emit } from './photo-library';
import { PresetStore } from './presets';
import { PreviewCache } from './previews';
import { ExportService } from './export-service';
import { SettingsStore } from './settings-store';
import { reconcileDestination } from './reconcile';
import { runTeardown } from './teardown';

export interface BackendOptions {
  /** Electron `userData`; everything the backend persists lives below it. */
  userDataDir: string;
  appVersion: string;
  emit: Emit;
  /** Fetches secrets from the main process (see `shared/secret-port.ts`). */
  getSecret: GetSecret;
  /** Home directory for the default ingest destination. */
  homeDir?: string;
  /** Overrides where the YuNet model is looked up. */
  yunetModelPath?: string;
  /** Tuning for the upload queue (tests use short retry delays). */
  uploadQueue?: Pick<
    UploadQueueOptions,
    'concurrencyPerDestination' | 'maxAttempts' | 'retryBaseDelayMs' | 'retryMaxDelayMs'
  >;
}

/** The real (non-mock) implementation of every channel, plus the `app://` resolver. */
export interface Backend {
  handlers: Partial<IpcHandlers>;
  layout: UserDataLayout;
  /** Settles when the startup scan for unindexed photos is done. */
  reconciled: Promise<void>;
  /** Index image files in the ingest destination that have no index entry; returns how many. */
  reconcile(): Promise<number>;
  resolveAppRequest(url: string): Promise<AppBackendResponse>;
  /** Stop ingest and uploads, close ExifTool and the databases. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Wires the workstream packages into the services behind the IPC channels. It
 * has no Electron dependency, so tests run it in plain Node.
 */
export async function createBackend(options: BackendOptions): Promise<Backend> {
  const layout = userDataLayout(options.userDataDir);
  mkdirSync(layout.root, { recursive: true });
  const { emit, getSecret } = options;
  const emitJob = (event: JobEvent): void => emit('jobs:event', event);

  const exiftool = new ExifToolService();
  const settings = new SettingsStore(
    layout.settingsFile,
    defaultSettings(options.homeDir ?? homedir()),
    (message) => console.warn(message),
  );
  const index = new PhotoIndex(layout.indexDb);
  const photos = new PhotoLibrary(index, emit);
  const previews = new PreviewCache(layout.thumbDir, layout.previewDir);
  const metadata = new MetadataService(photos, exiftool, settings);
  const edits = new EditService(photos, exiftool);
  const seenStore = new SqliteSeenStore(layout.seenDb);
  const presets = new PresetStore(layout.presetsDir);
  const faces = new FaceService(
    photos,
    options.yunetModelPath ?? findYuNetModel(import.meta.dirname),
  );
  const apps = new AppResources({ photos, previews, linearDir: layout.linearDir });
  await apps.init();

  const reportJobError = (event: { jobId?: JobId; scope: string; message: string }): void =>
    emitJob({ type: 'job.error', at: Date.now(), ...event });
  const templateMode = (): TemplateApplyMode =>
    (settings.get().ingest as BackendIngestSettings).metadataTemplateMode ?? DEFAULT_TEMPLATE_MODE;

  const ingest = new IngestService({
    seenStore,
    getSecret,
    onEvent: emitJob,
    onFileIngested: (config) =>
      createOnFileIngested(
        {
          photos,
          previews,
          metadata,
          edits,
          exiftool,
          report: (event) => emitJob({ type: 'job.error', at: Date.now(), ...event }),
        },
        config,
        (settings.get().ingest as BackendIngestSettings).metadataTemplateMode ??
          DEFAULT_TEMPLATE_MODE,
      ),
  });

  // The queue needs the export service's path expander and the export service
  // needs the queue, so the expander goes through a late-bound reference.
  const late: { exporter?: ExportService } = {};
  const queue = new UploadQueue({
    dbPath: layout.uploadsDb,
    hooks: {
      getSecret,
      expandPathTemplate: (template, context) =>
        late.exporter ? late.exporter.expandPathTemplate(template, context) : template,
    },
    ...options.uploadQueue,
  });
  const exporter = new ExportService({
    photos,
    settings,
    exiftool,
    queue,
    exportsDir: layout.exportsDir,
    onEvent: emitJob,
  });
  late.exporter = exporter;
  queue.start();

  // Pick up files that were copied but never indexed (crash or failed index write).
  const reconcileAbort = new AbortController();
  const reconcile = async (): Promise<number> => {
    const { ingest: ingestSettings } = settings.get();
    const hook = createOnFileIngested(
      { photos, previews, metadata, edits, exiftool, report: reportJobError },
      { metadataTemplatePath: ingestSettings.metadataTemplatePath },
      templateMode(),
    );
    return reconcileDestination({
      directory: ingestSettings.destination.path,
      known: index.paths(),
      index: hook,
      signal: reconcileAbort.signal,
      onError: (path, error) =>
        reportJobError({
          scope: 'reconcile',
          message: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  };
  const reconciled = reconcile().then(
    () => undefined,
    (error: unknown) =>
      reportJobError({
        scope: 'reconcile',
        message: `could not look for unindexed photos: ${error instanceof Error ? error.message : String(error)}`,
      }),
  );

  const handlers = withIpcErrors(
    createBackendHandlers({
      appVersion: options.appVersion,
      emit,
      getSecret,
      photos,
      settings,
      metadata,
      edits,
      faces,
      presets,
      ingest,
      queue,
      exporter,
    }),
  );

  let disposed: Promise<void> | undefined;
  return {
    handlers,
    layout,
    reconciled,
    reconcile,
    resolveAppRequest: (url) => apps.resolve(url),
    dispose: () => {
      disposed ??= runTeardown([
        // Order matters: ingest and uploads use ExifTool and the databases.
        { name: 'ingest', run: () => ingest.dispose() },
        { name: 'reconcile', run: () => (reconcileAbort.abort(), reconciled) },
        { name: 'face detection', run: () => faces.dispose() },
        { name: 'upload queue', run: () => queue.close() },
        { name: 'exiftool', run: () => exiftool.close() },
        { name: 'seen files', run: () => seenStore.close() },
        { name: 'photo index', run: () => index.close() },
      ]);
      return disposed;
    },
  };
}
