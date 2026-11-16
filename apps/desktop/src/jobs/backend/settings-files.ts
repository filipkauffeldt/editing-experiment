import type {
  AppSettings,
  DevelopSettingGroupId,
  Destination,
  ExportPreset,
  FileNamingMode,
  IptcFields,
  PanelWidths,
  PresetId,
  SourceConfig,
  TemplateApplyMode,
} from '@ee/contracts';
import {
  DEFAULT_FILE_NAMING,
  DEFAULT_TEMPLATE_MODE,
  isFileNamingMode,
  isObject,
  isTemplateApplyMode,
  migratePreset,
  migrateSource,
  sanitizeCopyMetadataFields,
  sanitizeCopySettingGroups,
  sanitizePanelWidths,
} from './settings-values';
import {
  isAbsolutePathFromEitherSystem,
  isSettingsPathRef,
  relativeToSettingsFolder,
  resolveSettingsPath,
  resolveUnderSettingsFolder,
  type SettingsPathRef,
} from './settings-paths';

/** Marker of the shared file, so an old combined `settings.json` is recognised. */
export const SHARED_FILE_FORMAT = 'ee-settings-folder';
export const SHARED_FILE_VERSION = 3;
/** Marker of this computer's file. */
export const MACHINE_FILE_FORMAT = 'ee-machine';
export const MACHINE_FILE_VERSION = 1;

/** What every computer has in common. Lives in the settings folder. */
export interface SharedSettings {
  ingest: {
    fileNaming: FileNamingMode;
    renameTemplate: string;
    metadataTemplateMode: TemplateApplyMode;
    developPresetId?: PresetId;
    /** Only the subfolder template; the destination path belongs to a machine. */
    destination?: { subfolderTemplate?: string };
    backupDestination?: { subfolderTemplate?: string };
    /** The ingest template as a path that may be shared, or one of this machine's. */
    metadataTemplate?: SettingsPathRef;
  };
  exportPresets: ExportPreset[];
  activePresetId?: PresetId;
  metadataTemplates: SettingsPathRef[];
  codeReplacementPaths: SettingsPathRef[];
  copyMetadataFields?: (keyof IptcFields)[];
  copySettingGroups?: DevelopSettingGroupId[];
  /** FTP and SFTP sources, without secrets (only their opaque `credentialRef`). */
  sources: SourceConfig[];
  /** FTP and SFTP destinations, without secrets. */
  destinations: Destination[];
  /**
   * Top-level fields from a current-version file this version does not know. They are
   * written back untouched, so a newer computer's settings are not stripped.
   */
  extra?: Record<string, unknown>;
  /** Fields inside `ingest` this version does not know. */
  ingestExtra?: Record<string, unknown>;
}

/** What belongs to one computer. Lives in `userData/machine.json`. */
export interface MachineSettings {
  /** The chosen settings folder; absent means the default (the userData folder). */
  settingsFolder?: string;
  ingest: {
    destinationPath: string;
    backupDestinationPath?: string;
  };
  exportRoot: string;
  profileFolders?: string[];
  presetFolders?: string[];
  panelWidths?: PanelWidths;
  /** `SettingsPathRef.machine` id → absolute path on this computer. */
  paths: Record<string, string>;
  /** Folder and card sources. */
  sources: SourceConfig[];
  /** Folder destinations. */
  destinations: Destination[];
  /** Top-level fields from a current-version file this version does not know. */
  extra?: Record<string, unknown>;
  /** Fields inside `ingest` this version does not know. */
  ingestExtra?: Record<string, unknown>;
}

export interface MergedSettings {
  settings: AppSettings;
  sources: SourceConfig[];
  destinations: Destination[];
}

export function sharedFileContents(shared: SharedSettings): Record<string, unknown> {
  const { ingest, ingestExtra, extra, ...known } = shared;
  return {
    version: SHARED_FILE_VERSION,
    format: SHARED_FILE_FORMAT,
    ...extra,
    ...known,
    ingest: { ...ingestExtra, ...ingest },
  };
}

export function machineFileContents(machine: MachineSettings): Record<string, unknown> {
  const { ingest, ingestExtra, extra, ...known } = machine;
  return {
    version: MACHINE_FILE_VERSION,
    format: MACHINE_FILE_FORMAT,
    ...extra,
    ...known,
    ingest: { ...ingestExtra, ...ingest },
  };
}

export function isSharedSettingsFile(parsed: unknown): boolean {
  return isObject(parsed) && parsed.format === SHARED_FILE_FORMAT;
}

export function isMachineSettingsFile(parsed: unknown): boolean {
  return isObject(parsed) && parsed.format === MACHINE_FILE_FORMAT;
}

export function isLocalSource(source: SourceConfig): boolean {
  return source.kind === 'folder' || source.kind === 'card';
}

export function isLocalDestination(destination: Destination): boolean {
  return destination.kind === 'folder';
}

/** Fields this version does not know, kept so a write does not strip a newer computer's file. */
function unknownFields(
  value: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> | undefined {
  const names = new Set(known);
  const extra = Object.fromEntries(Object.entries(value).filter(([name]) => !names.has(name)));
  return Object.keys(extra).length === 0 ? undefined : extra;
}

/** The shared half of a state, for a fresh install or a file that had everything. */
export function splitSettings(
  state: MergedSettings,
  folder: string,
  existingMachine: MachineSettings | undefined,
  newId: () => string,
): { shared: SharedSettings; machine: MachineSettings } {
  const machine: MachineSettings = existingMachine
    ? { ...existingMachine, paths: { ...existingMachine.paths } }
    : {
        ingest: {
          destinationPath: state.settings.ingest.destination.path,
          ...(state.settings.ingest.backupDestination === undefined
            ? {}
            : { backupDestinationPath: state.settings.ingest.backupDestination.path }),
        },
        exportRoot: state.settings.exportRoot,
        ...(state.settings.profileFolders === undefined
          ? {}
          : { profileFolders: [...state.settings.profileFolders] }),
        ...(state.settings.presetFolders === undefined
          ? {}
          : { presetFolders: [...state.settings.presetFolders] }),
        ...(state.settings.panelWidths === undefined
          ? {}
          : { panelWidths: state.settings.panelWidths }),
        paths: {},
        sources: state.sources.filter(isLocalSource),
        destinations: state.destinations.filter(isLocalDestination),
      };

  const refFor = (file: string): SettingsPathRef => {
    const relative = relativeToSettingsFolder(folder, file);
    if (relative !== undefined) return { folder: relative };
    // A relative value in old settings only ever meant a path below the folder.
    if (!isAbsolutePathFromEitherSystem(file)) {
      const normalized = file
        .split(/[\\/]+/)
        .join('/')
        .replace(/^\.\//, '');
      if (resolveUnderSettingsFolder(folder, normalized) !== undefined) {
        return { folder: normalized };
      }
    }
    const existing = Object.entries(machine.paths).find(([, stored]) => stored === file);
    if (existing !== undefined) return { machine: existing[0] };
    const id = `path-${newId()}`;
    machine.paths[id] = file;
    return { machine: id };
  };

  const ingest = state.settings.ingest;
  const shared: SharedSettings = {
    ingest: {
      fileNaming: ingest.fileNaming,
      renameTemplate: ingest.renameTemplate,
      metadataTemplateMode: ingest.metadataTemplateMode ?? DEFAULT_TEMPLATE_MODE,
      ...(ingest.developPresetId === undefined ? {} : { developPresetId: ingest.developPresetId }),
      ...(ingest.destination.subfolderTemplate === undefined
        ? {}
        : { destination: { subfolderTemplate: ingest.destination.subfolderTemplate } }),
      ...(ingest.backupDestination?.subfolderTemplate === undefined
        ? {}
        : {
            backupDestination: { subfolderTemplate: ingest.backupDestination.subfolderTemplate },
          }),
      ...(ingest.metadataTemplatePath === undefined || ingest.metadataTemplatePath.trim() === ''
        ? {}
        : { metadataTemplate: refFor(ingest.metadataTemplatePath) }),
    },
    exportPresets: state.settings.exportPresets,
    ...(state.settings.activePresetId === undefined
      ? {}
      : { activePresetId: state.settings.activePresetId }),
    metadataTemplates: (state.settings.metadataTemplates ?? []).map(refFor),
    codeReplacementPaths: (state.settings.codeReplacementPaths ?? []).map(refFor),
    ...(state.settings.copyMetadataFields === undefined
      ? {}
      : { copyMetadataFields: state.settings.copyMetadataFields }),
    ...(state.settings.copySettingGroups === undefined
      ? {}
      : { copySettingGroups: state.settings.copySettingGroups }),
    sources: state.sources.filter((source) => !isLocalSource(source)),
    destinations: state.destinations.filter((destination) => !isLocalDestination(destination)),
  };
  return { shared, machine };
}

/** The settings and lists this computer sees: its own paths plus the shared ones. */
export function mergeSettings(
  shared: SharedSettings,
  machine: MachineSettings,
  folder: string,
): MergedSettings {
  const resolve = (ref: SettingsPathRef): string | undefined =>
    resolveSettingsPath(folder, ref, machine.paths);
  const metadataTemplates = shared.metadataTemplates
    .map(resolve)
    .filter((path): path is string => path !== undefined);
  const codeReplacementPaths = shared.codeReplacementPaths
    .map(resolve)
    .filter((path): path is string => path !== undefined);
  const metadataTemplatePath =
    shared.ingest.metadataTemplate === undefined
      ? undefined
      : resolve(shared.ingest.metadataTemplate);
  const backupTemplate = shared.ingest.backupDestination?.subfolderTemplate;
  const destinationTemplate = shared.ingest.destination?.subfolderTemplate;
  const settings: AppSettings = {
    ingest: {
      destination: {
        path: machine.ingest.destinationPath,
        ...(destinationTemplate === undefined ? {} : { subfolderTemplate: destinationTemplate }),
      },
      ...(machine.ingest.backupDestinationPath === undefined
        ? {}
        : {
            backupDestination: {
              path: machine.ingest.backupDestinationPath,
              ...(backupTemplate === undefined ? {} : { subfolderTemplate: backupTemplate }),
            },
          }),
      fileNaming: shared.ingest.fileNaming,
      renameTemplate: shared.ingest.renameTemplate,
      ...(metadataTemplatePath === undefined ? {} : { metadataTemplatePath: metadataTemplatePath }),
      metadataTemplateMode: shared.ingest.metadataTemplateMode,
      ...(shared.ingest.developPresetId === undefined
        ? {}
        : { developPresetId: shared.ingest.developPresetId }),
    },
    exportRoot: machine.exportRoot,
    exportPresets: shared.exportPresets,
    ...(shared.activePresetId === undefined ? {} : { activePresetId: shared.activePresetId }),
    ...(machine.profileFolders === undefined ? {} : { profileFolders: machine.profileFolders }),
    ...(machine.presetFolders === undefined ? {} : { presetFolders: machine.presetFolders }),
    metadataTemplates,
    codeReplacementPaths,
    ...(shared.copyMetadataFields === undefined
      ? {}
      : { copyMetadataFields: shared.copyMetadataFields }),
    ...(shared.copySettingGroups === undefined
      ? {}
      : { copySettingGroups: shared.copySettingGroups }),
    ...(machine.panelWidths === undefined ? {} : { panelWidths: machine.panelWidths }),
  };
  return {
    settings,
    sources: [...machine.sources, ...shared.sources],
    destinations: [...machine.destinations, ...shared.destinations],
  };
}

/** Read a shared file, keeping what is usable and filling the rest from defaults. */
export function normalizeSharedFile(parsed: unknown, defaults: AppSettings): SharedSettings {
  if (!isObject(parsed)) throw new Error('settings file is not an object');
  const ingest = isObject(parsed.ingest) ? parsed.ingest : {};
  const presets =
    Array.isArray(parsed.exportPresets) && parsed.exportPresets.length > 0
      ? parsed.exportPresets.map((preset) => migratePreset(preset).preset)
      : defaults.exportPresets;
  const activePresetId =
    typeof parsed.activePresetId === 'string'
      ? (parsed.activePresetId as PresetId)
      : (presets[0]?.id ?? defaults.activePresetId);
  const pathRefs = (value: unknown): SettingsPathRef[] => {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const refs: SettingsPathRef[] = [];
    for (const item of value) {
      if (!isSettingsPathRef(item)) continue;
      const key = 'folder' in item ? `folder:${item.folder}` : `machine:${item.machine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(item);
    }
    return refs;
  };
  const destination = isObject(ingest.destination) ? ingest.destination : undefined;
  const backup = isObject(ingest.backupDestination) ? ingest.backupDestination : undefined;
  const subfolder = (value: Record<string, unknown> | undefined): string | undefined =>
    typeof value?.subfolderTemplate === 'string' && value.subfolderTemplate !== ''
      ? value.subfolderTemplate
      : undefined;
  const destinationTemplate = subfolder(destination);
  const backupTemplate = subfolder(backup);
  const copyMetadataFields = sanitizeCopyMetadataFields(parsed.copyMetadataFields);
  const copySettingGroups = sanitizeCopySettingGroups(parsed.copySettingGroups);
  const extra = unknownFields(parsed, [
    'version',
    'format',
    'ingest',
    'exportPresets',
    'activePresetId',
    'metadataTemplates',
    'codeReplacementPaths',
    'copyMetadataFields',
    'copySettingGroups',
    'sources',
    'destinations',
  ]);
  const ingestExtra = unknownFields(ingest, [
    'fileNaming',
    'renameTemplate',
    'metadataTemplateMode',
    'developPresetId',
    'destination',
    'backupDestination',
    'metadataTemplate',
  ]);
  return {
    ...(extra === undefined ? {} : { extra }),
    ...(ingestExtra === undefined ? {} : { ingestExtra }),
    ingest: {
      fileNaming: isFileNamingMode(ingest.fileNaming) ? ingest.fileNaming : DEFAULT_FILE_NAMING,
      renameTemplate:
        typeof ingest.renameTemplate === 'string'
          ? ingest.renameTemplate
          : defaults.ingest.renameTemplate,
      metadataTemplateMode: isTemplateApplyMode(ingest.metadataTemplateMode)
        ? ingest.metadataTemplateMode
        : DEFAULT_TEMPLATE_MODE,
      ...(typeof ingest.developPresetId === 'string'
        ? { developPresetId: ingest.developPresetId as PresetId }
        : {}),
      ...(destinationTemplate === undefined
        ? {}
        : { destination: { subfolderTemplate: destinationTemplate } }),
      ...(backupTemplate === undefined
        ? {}
        : { backupDestination: { subfolderTemplate: backupTemplate } }),
      ...(isSettingsPathRef(ingest.metadataTemplate)
        ? { metadataTemplate: ingest.metadataTemplate }
        : {}),
    },
    exportPresets: presets,
    ...(activePresetId === undefined ? {} : { activePresetId }),
    metadataTemplates: pathRefs(parsed.metadataTemplates),
    codeReplacementPaths: pathRefs(parsed.codeReplacementPaths),
    ...(copyMetadataFields === undefined ? {} : { copyMetadataFields }),
    ...(copySettingGroups === undefined ? {} : { copySettingGroups }),
    sources: (Array.isArray(parsed.sources) ? parsed.sources : [])
      .map(migrateSource)
      .filter((source) => !isLocalSource(source)),
    destinations: (Array.isArray(parsed.destinations) ? parsed.destinations : []).filter(
      (destination): destination is Destination =>
        isObject(destination) && destination.kind !== 'folder',
    ),
  };
}

/** Read this computer's file, filling every absent field from defaults. */
export function normalizeMachineFile(
  parsed: unknown,
  defaults: AppSettings,
  fallbackFolder: string,
): MachineSettings {
  const raw = isObject(parsed) ? parsed : {};
  const ingest = isObject(raw.ingest) ? raw.ingest : {};
  const paths: Record<string, string> = {};
  if (isObject(raw.paths)) {
    for (const [id, value] of Object.entries(raw.paths)) {
      if (typeof value === 'string' && value !== '') paths[id] = value;
    }
  }
  const extra = unknownFields(raw, [
    'version',
    'format',
    'settingsFolder',
    'ingest',
    'exportRoot',
    'profileFolders',
    'presetFolders',
    'panelWidths',
    'paths',
    'sources',
    'destinations',
  ]);
  const ingestExtra = unknownFields(ingest, ['destinationPath', 'backupDestinationPath']);
  return {
    ...(extra === undefined ? {} : { extra }),
    ...(ingestExtra === undefined ? {} : { ingestExtra }),
    ...(typeof raw.settingsFolder === 'string' && raw.settingsFolder !== ''
      ? { settingsFolder: raw.settingsFolder }
      : {}),
    ingest: {
      destinationPath:
        typeof ingest.destinationPath === 'string'
          ? ingest.destinationPath
          : defaults.ingest.destination.path,
      ...(typeof ingest.backupDestinationPath === 'string' && ingest.backupDestinationPath !== ''
        ? { backupDestinationPath: ingest.backupDestinationPath }
        : {}),
    },
    exportRoot:
      typeof raw.exportRoot === 'string' && raw.exportRoot !== ''
        ? raw.exportRoot
        : defaults.exportRoot || fallbackFolder,
    ...(() => {
      const folders = Array.isArray(raw.profileFolders)
        ? raw.profileFolders.filter(
            (folder): folder is string => typeof folder === 'string' && folder !== '',
          )
        : defaults.profileFolders;
      return folders === undefined ? {} : { profileFolders: [...folders] };
    })(),
    ...(() => {
      const folders = Array.isArray(raw.presetFolders)
        ? raw.presetFolders.filter(
            (folder): folder is string => typeof folder === 'string' && folder !== '',
          )
        : defaults.presetFolders;
      return folders === undefined ? {} : { presetFolders: [...folders] };
    })(),
    ...(() => {
      const widths = sanitizePanelWidths(raw.panelWidths) ?? defaults.panelWidths;
      return widths === undefined ? {} : { panelWidths: widths };
    })(),
    paths,
    sources: (Array.isArray(raw.sources) ? raw.sources : [])
      .map(migrateSource)
      .filter(isLocalSource),
    destinations: (Array.isArray(raw.destinations) ? raw.destinations : []).filter(
      (destination): destination is Destination =>
        isObject(destination) && destination.kind === 'folder',
    ),
  };
}
