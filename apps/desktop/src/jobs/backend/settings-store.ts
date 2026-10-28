import {
  IpcError,
  type AppSettings,
  type Destination,
  type DestinationId,
  type SourceConfig,
  type SourceId,
} from '@ee/contracts';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-json';

interface PersistedState extends AppSettings {
  sources: SourceConfig[];
  destinations: Destination[];
}

const FILE_VERSION = 1;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertIngest(value: unknown): asserts value is AppSettings['ingest'] {
  if (
    !isObject(value) ||
    !isObject(value.destination) ||
    typeof value.destination.path !== 'string' ||
    value.destination.path === '' ||
    typeof value.renameTemplate !== 'string' ||
    !Array.isArray(value.codeReplacementPaths)
  ) {
    throw new IpcError(
      'invalid_argument',
      'ingest settings need destination.path, renameTemplate and codeReplacementPaths',
    );
  }
}

function assertFinishAction(value: unknown): asserts value is AppSettings['finishAction'] {
  if (
    !isObject(value) ||
    !isObject(value.exportPreset) ||
    typeof value.exportPreset.quality !== 'number' ||
    !Array.isArray(value.destinations)
  ) {
    throw new IpcError('invalid_argument', 'finishAction needs exportPreset and destinations');
  }
}

/**
 * Sources, destinations, ingest options and the finish action as one JSON file
 * under userData. Passing no file keeps everything in memory.
 */
export class SettingsStore {
  private state: PersistedState;

  /**
   * @param onWarning called when an unreadable file was set aside and defaults are in use
   */
  constructor(
    private readonly file: string | undefined,
    defaults: AppSettings,
    onWarning: (message: string) => void = () => {},
  ) {
    this.state = { ...defaults, sources: [], destinations: [] };
    if (file === undefined || !existsSync(file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObject(parsed)) throw new Error('settings file is not an object');
      this.state = {
        ingest: isObject(parsed.ingest)
          ? (parsed.ingest as unknown as AppSettings['ingest'])
          : defaults.ingest,
        finishAction: isObject(parsed.finishAction)
          ? (parsed.finishAction as unknown as AppSettings['finishAction'])
          : defaults.finishAction,
        sources: Array.isArray(parsed.sources) ? (parsed.sources as SourceConfig[]) : [],
        destinations: Array.isArray(parsed.destinations)
          ? (parsed.destinations as Destination[])
          : [],
      };
    } catch (error) {
      const aside = `${file}.corrupt-${Date.now()}`;
      renameSync(file, aside);
      onWarning(
        `settings.json could not be read (${(error as Error).message}); moved to ${aside}, using defaults`,
      );
    }
  }

  get(): AppSettings {
    return { ingest: this.state.ingest, finishAction: this.state.finishAction };
  }

  set(patch: Partial<AppSettings>): AppSettings {
    if (patch.ingest !== undefined) assertIngest(patch.ingest);
    if (patch.finishAction !== undefined) assertFinishAction(patch.finishAction);
    this.state = {
      ...this.state,
      ...(patch.ingest !== undefined ? { ingest: patch.ingest } : {}),
      ...(patch.finishAction !== undefined ? { finishAction: patch.finishAction } : {}),
    };
    this.save();
    return this.get();
  }

  listSources(): SourceConfig[] {
    return this.state.sources;
  }

  saveSource(source: SourceConfig): SourceConfig {
    this.state = { ...this.state, sources: upsert(this.state.sources, source) };
    this.save();
    return source;
  }

  removeSource(sourceId: SourceId): void {
    this.state = {
      ...this.state,
      sources: this.state.sources.filter((source) => source.id !== sourceId),
    };
    this.save();
  }

  listDestinations(): Destination[] {
    return this.state.destinations;
  }

  getDestination(destinationId: DestinationId): Destination | undefined {
    return this.state.destinations.find((destination) => destination.id === destinationId);
  }

  saveDestination(destination: Destination): Destination {
    this.state = { ...this.state, destinations: upsert(this.state.destinations, destination) };
    this.save();
    return destination;
  }

  removeDestination(destinationId: DestinationId): void {
    this.state = {
      ...this.state,
      destinations: this.state.destinations.filter((d) => d.id !== destinationId),
      finishAction: {
        ...this.state.finishAction,
        destinations: this.state.finishAction.destinations.filter((id) => id !== destinationId),
      },
    };
    this.save();
  }

  private save(): void {
    if (this.file === undefined) return;
    writeJsonAtomic(this.file, { version: FILE_VERSION, ...this.state });
  }
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  if (typeof item.id !== 'string' || item.id === '') {
    throw new IpcError('invalid_argument', 'id is required');
  }
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((existing, i) => (i === index ? item : existing));
}
