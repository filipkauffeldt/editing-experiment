import {
  IpcError,
  asPresetId,
  type AppSettings,
  type Destination,
  type DestinationId,
  type ExportPreset,
  type PresetId,
  type SourceConfig,
  type SourceId,
} from '@ee/contracts';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-json';

interface PersistedState extends AppSettings {
  sources: SourceConfig[];
  destinations: Destination[];
}

/** The old single-action settings shape, kept only to migrate it. */
interface LegacyFinishAction {
  exportPreset?: {
    maxEdge?: unknown;
    quality?: unknown;
    metadata?: unknown;
  };
  destinations?: unknown;
}

const FILE_VERSION = 2;

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

function isQuality(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100;
}

function assertExportPreset(value: unknown): asserts value is ExportPreset {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    value.id === '' ||
    typeof value.name !== 'string' ||
    value.name.trim() === '' ||
    typeof value.folderTemplate !== 'string' ||
    value.folderTemplate.trim() === '' ||
    typeof value.fileNameTemplate !== 'string' ||
    value.fileNameTemplate.trim() === '' ||
    !['suffix', 'overwrite', 'skip'].includes(String(value.ifExists)) ||
    value.format !== 'jpeg' ||
    !isQuality(value.quality) ||
    value.colorSpace !== 'srgb' ||
    !isObject(value.resize) ||
    !['none', 'longEdge', 'shortEdge', 'megapixels'].includes(String(value.resize.mode)) ||
    !isObject(value.outputSharpening) ||
    !['none', 'screen', 'matte', 'glossy'].includes(String(value.outputSharpening.target)) ||
    !['low', 'standard', 'high'].includes(String(value.outputSharpening.amount)) ||
    !['all', 'iptc', 'copyright', 'none'].includes(String(value.metadata)) ||
    typeof value.stripGps !== 'boolean' ||
    !['top', 'develop'].includes(String(value.version)) ||
    !Array.isArray(value.sendTo)
  ) {
    throw new IpcError(
      'invalid_argument',
      'export presets need id, name, templates, ifExists, format, quality, colorSpace, ' +
        'resize, outputSharpening, metadata, stripGps, version and sendTo',
    );
  }
  if (value.version === 'develop' && value.sendTo.length > 0) {
    throw new IpcError(
      'invalid_argument',
      'a develop-only export preset cannot have send targets; use the top retouch version',
    );
  }
}

function assertSettingsPatch(patch: Partial<AppSettings>): void {
  if (patch.ingest !== undefined) assertIngest(patch.ingest);
  if (
    patch.exportRoot !== undefined &&
    (typeof patch.exportRoot !== 'string' || patch.exportRoot === '')
  ) {
    throw new IpcError('invalid_argument', 'exportRoot must be a non-empty path');
  }
  if (patch.exportPresets !== undefined) {
    if (!Array.isArray(patch.exportPresets) || patch.exportPresets.length === 0) {
      throw new IpcError('invalid_argument', 'exportPresets must be a non-empty array');
    }
    for (const preset of patch.exportPresets) assertExportPreset(preset);
  }
  if (patch.activePresetId !== undefined && typeof patch.activePresetId !== 'string') {
    throw new IpcError('invalid_argument', 'activePresetId must be a preset id');
  }
}

/** Turn the old FinishAction into a preset, keeping its destinations and size limit. */
function presetFromFinishAction(legacy: LegacyFinishAction, fallback: ExportPreset): ExportPreset {
  const old = isObject(legacy.exportPreset) ? legacy.exportPreset : {};
  const destinations = Array.isArray(legacy.destinations)
    ? legacy.destinations.filter((id): id is DestinationId => typeof id === 'string')
    : [];
  const metadata = ['all', 'iptc', 'none'].includes(String(old.metadata))
    ? (old.metadata as ExportPreset['metadata'])
    : 'all';
  const maxEdge =
    typeof old.maxEdge === 'number' && Number.isInteger(old.maxEdge) && old.maxEdge > 0
      ? old.maxEdge
      : undefined;
  return {
    ...fallback,
    id: asPresetId('migrated-default'),
    name: 'Default',
    quality: isQuality(old.quality) ? old.quality : fallback.quality,
    resize: maxEdge === undefined ? { mode: 'none' } : { mode: 'longEdge', pixels: maxEdge },
    metadata,
    sendTo: destinations,
  };
}

/**
 * Sources, destinations, ingest options, export presets and the active preset
 * as one JSON file under userData. Passing no file keeps everything in memory.
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
    let migrated = false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObject(parsed)) throw new Error('settings file is not an object');
      const fallbackPreset = defaults.exportPresets[0];
      if (!fallbackPreset) throw new Error('default settings have no export preset');
      let presets: ExportPreset[];
      if (Array.isArray(parsed.exportPresets) && parsed.exportPresets.length > 0) {
        presets = parsed.exportPresets as ExportPreset[];
      } else if (isObject(parsed.finishAction)) {
        presets = [
          presetFromFinishAction(parsed.finishAction as LegacyFinishAction, fallbackPreset),
        ];
        migrated = true;
      } else {
        presets = defaults.exportPresets;
      }
      const activePresetId =
        typeof parsed.activePresetId === 'string'
          ? (parsed.activePresetId as PresetId)
          : (presets[0]?.id ?? defaults.activePresetId);
      this.state = {
        ingest: isObject(parsed.ingest)
          ? (parsed.ingest as unknown as AppSettings['ingest'])
          : defaults.ingest,
        exportRoot:
          typeof parsed.exportRoot === 'string' && parsed.exportRoot !== ''
            ? parsed.exportRoot
            : defaults.exportRoot,
        exportPresets: presets,
        ...(activePresetId === undefined ? {} : { activePresetId }),
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
    if (migrated) this.save();
  }

  get(): AppSettings {
    return {
      ingest: this.state.ingest,
      exportRoot: this.state.exportRoot,
      exportPresets: this.state.exportPresets,
      ...(this.state.activePresetId === undefined
        ? {}
        : { activePresetId: this.state.activePresetId }),
    };
  }

  set(patch: Partial<AppSettings>): AppSettings {
    assertSettingsPatch(patch);
    this.state = {
      ...this.state,
      ...(patch.ingest !== undefined ? { ingest: patch.ingest } : {}),
      ...(patch.exportRoot !== undefined ? { exportRoot: patch.exportRoot } : {}),
      ...(patch.exportPresets !== undefined ? { exportPresets: patch.exportPresets } : {}),
      ...(patch.activePresetId !== undefined ? { activePresetId: patch.activePresetId } : {}),
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
      exportPresets: this.state.exportPresets.map((preset) => ({
        ...preset,
        sendTo: preset.sendTo.filter((id) => id !== destinationId),
      })),
    };
    this.save();
  }

  listExportPresets(): ExportPreset[] {
    return this.state.exportPresets;
  }

  getExportPreset(presetId: PresetId): ExportPreset | undefined {
    return this.state.exportPresets.find((preset) => preset.id === presetId);
  }

  activeExportPreset(): ExportPreset | undefined {
    const { activePresetId, exportPresets } = this.state;
    return exportPresets.find((preset) => preset.id === activePresetId) ?? exportPresets[0];
  }

  saveExportPreset(preset: ExportPreset): ExportPreset {
    assertExportPreset(preset);
    this.state = {
      ...this.state,
      exportPresets: upsert(this.state.exportPresets, preset),
    };
    this.save();
    return preset;
  }

  removeExportPreset(presetId: PresetId): void {
    if (this.state.exportPresets.length <= 1) {
      throw new IpcError('invalid_argument', 'at least one export preset must remain');
    }
    const remaining = this.state.exportPresets.filter((preset) => preset.id !== presetId);
    if (remaining.length === this.state.exportPresets.length) return;
    this.state = {
      ...this.state,
      exportPresets: remaining,
      ...(this.state.activePresetId === presetId ? { activePresetId: remaining[0]?.id } : {}),
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
