import {
  IpcError,
  type AppSettings,
  type Destination,
  type DestinationId,
  type ExportPreset,
  type PresetId,
  type SourceConfig,
  type SourceId,
} from '@ee/contracts';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { writeJsonAtomic } from './atomic-json';
import {
  SHARED_FILE_VERSION,
  mergeSettings,
  isMachineSettingsFile,
  isSharedSettingsFile,
  machineFileContents,
  normalizeMachineFile,
  normalizeSharedFile,
  sharedFileContents,
  splitSettings,
  type MachineSettings,
  type MergedSettings,
  type SharedSettings,
} from './settings-files';
import { readLegacySettings } from './settings-legacy';
import type { SettingsPathRef } from './settings-paths';
import { relativeToSettingsFolder, resolveSettingsPath } from './settings-paths';
import {
  DEFAULT_TEMPLATE_MODE,
  assertSettingsPatch,
  assertExportPreset,
  isObject,
  sanitizeCopyMetadataFields,
  sanitizeCopySettingGroups,
  sanitizePanelWidths,
  sanitizeSavedFilters,
  sanitizeStoredFilter,
} from './settings-values';

/** The folder the shared settings live in, as Settings → Settings folder shows it. */
export interface SettingsFolderInfo {
  /** The folder in use. */
  path: string;
  /** The default, below Electron's `userData`. */
  defaultPath: string;
  isDefault: boolean;
  /** Whether that folder holds a `settings.json` now. */
  hasSettings: boolean;
  /** Set when the folder is missing or not writable; nothing is written then. */
  problem?: string;
}

/** What inspecting a folder before using it says. */
export interface SettingsFolderChoice {
  path: string;
  /** True when the folder already holds settings, which are then used. */
  hasSettings: boolean;
  /** A reason the folder cannot be used now. */
  problem?: string;
}

const PRESET_FILE = /^[0-9a-f]{24}\.json$/;

const serialized = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Sources, destinations, ingest options, export presets and the rest of the settings,
 * split over two files:
 *
 * - `settings.json` in the settings folder holds what every computer has in common and
 *   is meant to be synced.
 * - `userData/machine.json` holds the paths and UI state that belong to this computer,
 *   and the choice of settings folder itself.
 *
 * The old single `settings.json` is split on first run. Its original is kept next to the
 * new file as `settings.json.pre-settings-folder`. Passing no file keeps everything in
 * memory (tests).
 */
export class SettingsStore {
  private shared: SharedSettings;
  private machine: MachineSettings;
  private folder: string;
  private readonly defaultFolder: string;
  private readonly machineFile: string | undefined;
  private readonly machineExisted: boolean;
  private lastSharedRaw: string | undefined;
  private problem: string | undefined;
  /** The shared file says it came from a newer app version: read it, never write it. */
  private newerVersion: string | undefined;
  /** The shared file in a synced folder could not be read: do not replace it with defaults. */
  private unreadableFile: string | undefined;

  /**
   * @param file the `userData/settings.json` path; its folder is the default settings folder
   * @param onWarning called when a file was set aside or a folder cannot be used
   */
  constructor(
    private readonly file: string | undefined,
    private readonly defaults: AppSettings,
    private readonly onWarning: (message: string) => void = () => {},
  ) {
    this.defaultFolder = file === undefined ? '' : dirname(file);
    this.machineFile = file === undefined ? undefined : join(this.defaultFolder, 'machine.json');
    const machineRead = this.readMachine();
    this.machine = machineRead.machine;
    this.machineExisted = machineRead.existed;
    this.folder = this.machine.settingsFolder ?? this.defaultFolder;

    if (file === undefined) {
      const split = splitSettings(this.defaultState(), '', undefined, newId);
      this.shared = split.shared;
      this.machine = split.machine;
      return;
    }

    this.problem = this.checkFolder(this.folder);
    if (this.problem === undefined || existsSync(this.folder)) {
      const loaded = this.loadSharedFile(this.folder, this.machine);
      this.shared = loaded.shared;
      this.machine = loaded.machine;
    } else {
      // The sync drive is not mounted: keep everything in memory and refuse to write.
      this.shared = splitSettings(this.defaultState(), this.folder, this.machine, newId).shared;
    }
  }

  private defaultState(): MergedSettings {
    return { settings: this.defaults, sources: [], destinations: [] };
  }

  private warn(message: string): void {
    this.onWarning(message);
  }

  // ------------------------------------------------------------- this computer

  private readMachine(): { machine: MachineSettings; existed: boolean } {
    if (this.machineFile === undefined) {
      return { machine: normalizeMachineFile(undefined, this.defaults, ''), existed: false };
    }
    if (!existsSync(this.machineFile)) {
      return { machine: normalizeMachineFile(undefined, this.defaults, ''), existed: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.machineFile, 'utf8'));
      if (!isMachineSettingsFile(parsed)) throw new Error('unexpected machine file');
    } catch (error) {
      this.warn(
        `machine.json could not be read (${messageOf(error)}); using this computer's defaults`,
      );
      this.moveAside(this.machineFile);
      return { machine: normalizeMachineFile(undefined, this.defaults, ''), existed: false };
    }
    const machine = normalizeMachineFile(parsed, this.defaults, '');
    if (machine.settingsFolder !== undefined && !isAbsolute(machine.settingsFolder)) {
      // A path of another path system: it is never joined or resolved on this one.
      this.warn(
        `machine.json names the settings folder "${machine.settingsFolder}", which is not a ` +
          'path on this computer; using the default folder',
      );
      delete machine.settingsFolder;
    }
    return { machine, existed: true };
  }

  private moveAside(file: string): string | undefined {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, aside);
      return aside;
    } catch (error) {
      this.warn(`${file} could not be moved aside (${messageOf(error)})`);
      return undefined;
    }
  }

  private checkFolder(folder: string): string | undefined {
    if (!existsSync(folder)) {
      return (
        `The settings folder "${folder}" is not available. Nothing was written. ` +
        'Check the sync drive or choose another folder in Settings → Settings folder.'
      );
    }
    try {
      if (!statSync(folder).isDirectory()) {
        return `The settings folder "${folder}" is not a folder. Nothing was written.`;
      }
    } catch (error) {
      return `The settings folder "${folder}" could not be read (${messageOf(error)}). Nothing was written.`;
    }
    try {
      accessSync(folder, constants.W_OK);
    } catch {
      return `The settings folder "${folder}" is not writable. Nothing was written.`;
    }
    return undefined;
  }

  // --------------------------------------------------------------- the shared file

  private sharedFileAt(folder: string): string {
    return join(folder, 'settings.json');
  }

  private currentSharedFile(): string {
    return this.sharedFileAt(this.folder);
  }

  /**
   * Read the shared settings in `folder`. A file written by an older version is split and
   * kept as `settings.json.pre-settings-folder`; a half-finished split is recovered from
   * its temp file. A current file is never written here: another computer may serialise
   * it differently, and rewriting it on every start would make sync conflicts.
   */
  private loadSharedFile(
    folder: string,
    machine: MachineSettings,
  ): { shared: SharedSettings; machine: MachineSettings } {
    this.newerVersion = undefined;
    this.unreadableFile = undefined;
    const file = this.sharedFileAt(folder);
    if (!existsSync(file)) return this.recover(folder, machine);
    const raw = readFileSync(file, 'utf8');
    let parsed: unknown;
    let readError: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      readError = error;
      parsed = undefined;
    }
    if (isSharedSettingsFile(parsed)) {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === 'number' && version > SHARED_FILE_VERSION) {
        this.newerVersion =
          `The settings file was written by a newer version of the app (version ${version}). ` +
          'Nothing was written. Update the app on this computer to change the settings.';
      }
      this.lastSharedRaw = raw;
      return { shared: normalizeSharedFile(parsed, this.defaults), machine };
    }
    if (isObject(parsed)) {
      // The one-file layout: split it, keeping every migration it needs.
      try {
        const legacy = readLegacySettings(parsed, this.defaults);
        const split = splitSettings(
          { settings: legacy.settings, sources: legacy.sources, destinations: legacy.destinations },
          folder,
          this.machineExisted ? machine : undefined,
          newId,
        );
        this.writeMachineFor(split.machine);
        const wrote = this.writeMigrated(folder, split.shared, true);
        this.lastSharedRaw = wrote
          ? serialized(sharedFileContents(split.shared))
          : existsSync(file)
            ? readFileSync(file, 'utf8')
            : raw;
        return split;
      } catch (error) {
        readError = error;
      }
    }
    this.reportUnreadable(folder, file, readError ?? new Error('not a settings object'));
    return splitSettings(this.defaultState(), folder, machine, newId);
  }

  /**
   * A file that does not parse is not ours to replace in a synced folder. The default
   * `userData` file keeps the old behaviour and is set aside.
   */
  private reportUnreadable(folder: string, file: string, error: unknown): void {
    const reason = messageOf(error);
    if (folder === this.defaultFolder) {
      const aside = this.checkFolder(folder) === undefined ? this.moveAside(file) : undefined;
      this.warn(
        `settings.json could not be read (${reason})` +
          `${aside === undefined ? '' : `; moved to ${aside}`}; the defaults are used`,
      );
      return;
    }
    this.unreadableFile =
      `The settings file in "${folder}" could not be read (${reason}). Nothing was written. ` +
      'It may be half-synced or a conflict copy.';
    this.warn(this.unreadableFile);
  }

  /** Write this computer's half when a migration changed it, before the shared file. */
  private writeMachineFor(machine: MachineSettings): void {
    if (this.machineFile === undefined) return;
    if (this.checkFolder(this.defaultFolder) !== undefined) return;
    if (serialized(machineFileContents(machine)) === this.serializedMachine()) return;
    writeJsonAtomic(this.machineFile, machineFileContents(machine));
  }

  /**
   * No `settings.json`: adopt a temp file left halfway through a split, migrate the backup
   * the split kept, or start from defaults. A missing external folder is never created.
   */
  private recover(
    folder: string,
    machine: MachineSettings,
  ): { shared: SharedSettings; machine: MachineSettings } {
    const file = this.sharedFileAt(folder);
    const temp = `${file}.migrating`;
    const backup = `${file}.pre-settings-folder`;
    if (existsSync(temp) && existsSync(backup)) {
      try {
        const raw = readFileSync(temp, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!isSharedSettingsFile(parsed)) throw new Error('the temp file is not shared settings');
        renameSync(temp, file);
        this.lastSharedRaw = raw;
        return { shared: normalizeSharedFile(parsed, this.defaults), machine };
      } catch (error) {
        this.warn(
          `a half-written settings file could not be used (${messageOf(error)}); ` +
            'starting from the backup',
        );
        if (this.checkFolder(folder) === undefined) this.moveAside(temp);
      }
    }
    if (existsSync(backup)) {
      const raw = readFileSync(backup, 'utf8');
      const split = this.sharedFromRaw(raw, folder, machine);
      if (split !== undefined) {
        this.writeMachineFor(split.machine);
        const wrote = this.writeMigrated(folder, split.shared, false);
        this.lastSharedRaw = wrote
          ? serialized(sharedFileContents(split.shared))
          : existsSync(file)
            ? readFileSync(file, 'utf8')
            : raw;
        return split;
      }
    }
    // A new settings folder (or a fresh install): the defaults, written when something changes.
    return splitSettings(this.defaultState(), folder, machine, newId);
  }

  /** Write a split shared file before the old one is retired; the old file is kept. */
  private writeMigrated(folder: string, shared: SharedSettings, moveOld: boolean): boolean {
    if (this.file === undefined) return false;
    if (this.checkFolder(folder) !== undefined) return false;
    const file = this.sharedFileAt(folder);
    const temp = `${file}.migrating`;
    mkdirSync(folder, { recursive: true });
    writeFileSync(temp, serialized(sharedFileContents(shared)));
    if (moveOld && existsSync(file)) {
      const backup = `${file}.pre-settings-folder`;
      renameSync(file, existsSync(backup) ? `${backup}-${Date.now()}` : backup);
    }
    renameSync(temp, file);
    return true;
  }

  // ------------------------------------------------------------------- reading

  get(): AppSettings {
    return mergeSettings(this.shared, this.machine, this.folder).settings;
  }

  listSources(): SourceConfig[] {
    return mergeSettings(this.shared, this.machine, this.folder).sources;
  }

  /** This computer's shared thumbnail/preview cache limit, or undefined for the default. */
  cacheLimitBytes(): number | undefined {
    return this.machine.cacheLimitBytes;
  }

  listDestinations(): Destination[] {
    return mergeSettings(this.shared, this.machine, this.folder).destinations;
  }

  getDestination(destinationId: DestinationId): Destination | undefined {
    return this.listDestinations().find((destination) => destination.id === destinationId);
  }

  listExportPresets(): ExportPreset[] {
    return this.shared.exportPresets;
  }

  getExportPreset(presetId: PresetId): ExportPreset | undefined {
    return this.shared.exportPresets.find((preset) => preset.id === presetId);
  }

  activeExportPreset(): ExportPreset | undefined {
    const { activePresetId, exportPresets } = this.shared;
    return exportPresets.find((preset) => preset.id === activePresetId) ?? exportPresets[0];
  }

  // ------------------------------------------------------------------- writing

  private get writeProblem(): string | undefined {
    return this.problem ?? this.newerVersion ?? this.unreadableFile;
  }

  private assertWritable(): void {
    if (this.file === undefined) return;
    const problem = this.writeProblem;
    if (problem !== undefined) throw new IpcError('io', problem);
  }

  /**
   * Write the shared file. If another computer changed it since this app read it, read it
   * again and apply only `mutate`, so the other change is not overwritten. The temp file
   * and the rename are in the settings folder, so a sync tool never sees half a file.
   */
  private commitShared(mutate: (shared: SharedSettings) => SharedSettings): SharedSettings {
    if (this.file === undefined) {
      this.shared = mutate(this.shared);
      return this.shared;
    }
    this.assertWritable();
    const file = this.currentSharedFile();
    let base = this.shared;
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      if (raw !== this.lastSharedRaw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw new IpcError(
            'io',
            `settings.json changed on disk and could not be read (${messageOf(error)}); ` +
              'nothing was written',
          );
        }
        if (!isSharedSettingsFile(parsed)) {
          throw new IpcError(
            'io',
            'settings.json changed on disk and is not a settings file this version knows; ' +
              'nothing was written',
          );
        }
        base = normalizeSharedFile(parsed, this.defaults);
      }
    }
    const next = mutate(base);
    const raw = serialized(sharedFileContents(next));
    writeJsonAtomic(file, sharedFileContents(next));
    this.shared = next;
    this.lastSharedRaw = raw;
    return next;
  }

  private commitMachine(mutate: (machine: MachineSettings) => MachineSettings): MachineSettings {
    if (this.machineFile === undefined) {
      this.machine = mutate(this.machine);
      return this.machine;
    }
    this.assertWritable();
    const next = mutate(this.machine);
    writeJsonAtomic(this.machineFile, machineFileContents(next));
    this.machine = next;
    return next;
  }

  /** Write whichever half changed, the machine file first so no path reference dangles. */
  private commit(
    sharedMutate?: (shared: SharedSettings) => SharedSettings,
    machineMutate?: (machine: MachineSettings) => MachineSettings,
  ): void {
    if (this.file === undefined) {
      if (sharedMutate) this.shared = sharedMutate(this.shared);
      if (machineMutate) this.machine = machineMutate(this.machine);
      return;
    }
    const nextShared = sharedMutate ? sharedMutate(this.shared) : this.shared;
    const nextMachine = machineMutate ? machineMutate(this.machine) : this.machine;
    const sharedChanged = serialized(sharedFileContents(nextShared)) !== this.serializedShared();
    const machineChanged =
      serialized(machineFileContents(nextMachine)) !== this.serializedMachine();
    if (machineChanged) this.commitMachine(() => nextMachine);
    if (sharedChanged) this.commitShared(sharedMutate ?? ((shared) => shared));
  }

  private serializedShared(): string {
    return serialized(sharedFileContents(this.shared));
  }

  private serializedMachine(): string {
    return serialized(machineFileContents(this.machine));
  }

  /** The reference for one absolute path: below the folder, or an id for this computer. */
  private refFor(file: string, paths: Record<string, string>): SettingsPathRef {
    const relative = relativeToSettingsFolder(this.folder, file);
    if (relative !== undefined) return { folder: relative };
    const existing = Object.entries(paths).find(([, stored]) => stored === file);
    if (existing !== undefined) return { machine: existing[0] };
    const id = `path-${randomUUID()}`;
    paths[id] = file;
    return { machine: id };
  }

  set(patch: Partial<AppSettings>): AppSettings {
    assertSettingsPatch(patch);
    const paths = { ...this.machine.paths };
    const machinePathsBefore = this.machine.paths;
    const resolves = (ref: SettingsPathRef): boolean =>
      resolveSettingsPath(this.folder, ref, machinePathsBefore) !== undefined;
    const metadataTemplateRef =
      patch.ingest?.metadataTemplatePath === undefined ||
      patch.ingest.metadataTemplatePath.trim() === ''
        ? undefined
        : this.refFor(patch.ingest.metadataTemplatePath, paths);
    const keepUnresolved = (
      refs: SettingsPathRef[],
      existing: SettingsPathRef[],
    ): SettingsPathRef[] => {
      const result = [...refs];
      for (const ref of existing) {
        if (resolves(ref)) continue;
        const duplicate = result.some((candidate) =>
          'folder' in candidate && 'folder' in ref
            ? candidate.folder === ref.folder
            : 'machine' in candidate && 'machine' in ref
              ? candidate.machine === ref.machine
              : false,
        );
        if (!duplicate) result.push(ref);
      }
      return result;
    };
    const metadataTemplateRefs =
      patch.metadataTemplates === undefined
        ? undefined
        : [...new Set(patch.metadataTemplates)].map((path) => this.refFor(path, paths));
    const codeReplacementRefs =
      patch.codeReplacementPaths === undefined
        ? undefined
        : [...new Set(patch.codeReplacementPaths)].map((path) => this.refFor(path, paths));

    // Remove a machine path entry once no shared reference uses it any more. This runs
    // only when a path field changes, so ordinary settings writes leave the map alone.
    if (
      patch.ingest !== undefined ||
      patch.metadataTemplates !== undefined ||
      patch.codeReplacementPaths !== undefined
    ) {
      const keptIngestTemplate =
        patch.ingest !== undefined &&
        metadataTemplateRef === undefined &&
        patch.ingest.metadataTemplatePath === undefined &&
        this.shared.ingest.metadataTemplate !== undefined &&
        !resolves(this.shared.ingest.metadataTemplate)
          ? this.shared.ingest.metadataTemplate
          : undefined;
      const ingestTemplate =
        patch.ingest === undefined
          ? this.shared.ingest.metadataTemplate
          : (metadataTemplateRef ?? keptIngestTemplate);
      const finalMetadataTemplates =
        metadataTemplateRefs === undefined
          ? this.shared.metadataTemplates
          : keepUnresolved(metadataTemplateRefs, this.shared.metadataTemplates);
      const finalCodeReplacementPaths =
        codeReplacementRefs === undefined
          ? this.shared.codeReplacementPaths
          : keepUnresolved(codeReplacementRefs, this.shared.codeReplacementPaths);
      const referenced = new Set<string>();
      for (const ref of [
        ...finalMetadataTemplates,
        ...finalCodeReplacementPaths,
        ...(ingestTemplate === undefined ? [] : [ingestTemplate]),
      ]) {
        if ('machine' in ref) referenced.add(ref.machine);
      }
      for (const id of Object.keys(paths)) {
        if (!referenced.has(id)) delete paths[id];
      }
    }

    const sharedMutate = (shared: SharedSettings): SharedSettings => {
      let next = shared;
      if (patch.ingest !== undefined) {
        const ingest = patch.ingest;
        const existingTemplate = shared.ingest.metadataTemplate;
        const keptTemplate =
          metadataTemplateRef === undefined &&
          ingest.metadataTemplatePath === undefined &&
          existingTemplate !== undefined &&
          !resolves(existingTemplate)
            ? existingTemplate
            : undefined;
        const templateRef = metadataTemplateRef ?? keptTemplate;
        next = {
          ...next,
          ingest: {
            fileNaming: ingest.fileNaming,
            renameTemplate: ingest.renameTemplate,
            metadataTemplateMode: ingest.metadataTemplateMode ?? DEFAULT_TEMPLATE_MODE,
            ...(ingest.developPresetId === undefined
              ? {}
              : { developPresetId: ingest.developPresetId }),
            ...(ingest.destination.subfolderTemplate === undefined
              ? {}
              : { destination: { subfolderTemplate: ingest.destination.subfolderTemplate } }),
            ...(ingest.backupDestination?.subfolderTemplate === undefined
              ? {}
              : {
                  backupDestination: {
                    subfolderTemplate: ingest.backupDestination.subfolderTemplate,
                  },
                }),
            ...(templateRef === undefined ? {} : { metadataTemplate: templateRef }),
          },
        };
      }
      if (patch.exportPresets !== undefined) {
        next = { ...next, exportPresets: patch.exportPresets };
      }
      if (patch.activePresetId !== undefined) {
        next = { ...next, activePresetId: patch.activePresetId };
      }
      if (metadataTemplateRefs !== undefined) {
        next = {
          ...next,
          metadataTemplates: keepUnresolved(metadataTemplateRefs, shared.metadataTemplates),
        };
      }
      if (codeReplacementRefs !== undefined) {
        next = {
          ...next,
          codeReplacementPaths: keepUnresolved(codeReplacementRefs, shared.codeReplacementPaths),
        };
      }
      if (patch.copyMetadataFields !== undefined) {
        next = {
          ...next,
          copyMetadataFields: sanitizeCopyMetadataFields(patch.copyMetadataFields) ?? [],
        };
      }
      if (patch.copySettingGroups !== undefined) {
        next = {
          ...next,
          copySettingGroups: sanitizeCopySettingGroups(patch.copySettingGroups) ?? [],
        };
      }
      if (patch.autoAdvance !== undefined) next = { ...next, autoAdvance: patch.autoAdvance };
      if (patch.savedFilters !== undefined) {
        const saved = sanitizeSavedFilters(patch.savedFilters) ?? [];
        // An empty list is the same as never saved: the key goes, as with the other lists.
        next = { ...next, savedFilters: saved.length === 0 ? undefined : saved };
      }
      return next;
    };

    const machineMutate = (machine: MachineSettings): MachineSettings => ({
      ...machine,
      ingest: {
        destinationPath:
          patch.ingest === undefined
            ? machine.ingest.destinationPath
            : patch.ingest.destination.path,
        ...(patch.ingest === undefined
          ? machine.ingest.backupDestinationPath === undefined
            ? {}
            : { backupDestinationPath: machine.ingest.backupDestinationPath }
          : patch.ingest.backupDestination === undefined
            ? {}
            : { backupDestinationPath: patch.ingest.backupDestination.path }),
      },
      ...(patch.exportRoot === undefined ? {} : { exportRoot: patch.exportRoot }),
      ...(patch.profileFolders === undefined
        ? {}
        : { profileFolders: [...new Set(patch.profileFolders)] }),
      ...(patch.presetFolders === undefined
        ? {}
        : { presetFolders: [...new Set(patch.presetFolders)] }),
      ...(patch.panelWidths === undefined
        ? {}
        : { panelWidths: sanitizePanelWidths(patch.panelWidths) ?? {} }),
      ...(patch.cacheLimitBytes === undefined ? {} : { cacheLimitBytes: patch.cacheLimitBytes }),
      ...(patch.currentFilter === undefined
        ? {}
        : { currentFilter: sanitizeStoredFilter(patch.currentFilter) }),
      paths,
    });

    this.commit(sharedMutate, machineMutate);
    return this.get();
  }

  saveSource(source: SourceConfig): SourceConfig {
    assertId(source.id);
    const machine = (current: MachineSettings): MachineSettings => ({
      ...current,
      sources:
        source.kind === 'folder' || source.kind === 'card'
          ? upsert(current.sources, source)
          : current.sources.filter((existing) => existing.id !== source.id),
    });
    const shared = (current: SharedSettings): SharedSettings => ({
      ...current,
      sources:
        source.kind === 'folder' || source.kind === 'card'
          ? current.sources.filter((existing) => existing.id !== source.id)
          : upsert(current.sources, source),
    });
    this.commit(shared, machine);
    return source;
  }

  removeSource(sourceId: SourceId): void {
    this.commit(
      (shared) => ({
        ...shared,
        sources: shared.sources.filter((source) => source.id !== sourceId),
      }),
      (machine) => ({
        ...machine,
        sources: machine.sources.filter((source) => source.id !== sourceId),
      }),
    );
  }

  saveDestination(destination: Destination): Destination {
    assertId(destination.id);
    const machine = (current: MachineSettings): MachineSettings => ({
      ...current,
      destinations:
        destination.kind === 'folder'
          ? upsert(current.destinations, destination)
          : current.destinations.filter((existing) => existing.id !== destination.id),
    });
    const shared = (current: SharedSettings): SharedSettings => ({
      ...current,
      destinations:
        destination.kind === 'folder'
          ? current.destinations.filter((existing) => existing.id !== destination.id)
          : upsert(current.destinations, destination),
    });
    this.commit(shared, machine);
    return destination;
  }

  removeDestination(destinationId: DestinationId): void {
    this.commit(
      (shared) => ({
        ...shared,
        destinations: shared.destinations.filter((destination) => destination.id !== destinationId),
        exportPresets: shared.exportPresets.map((preset) => ({
          ...preset,
          sendTo: preset.sendTo.filter((id) => id !== destinationId),
        })),
      }),
      (machine) => ({
        ...machine,
        destinations: machine.destinations.filter(
          (destination) => destination.id !== destinationId,
        ),
      }),
    );
  }

  saveExportPreset(preset: ExportPreset): ExportPreset {
    assertExportPreset(preset);
    this.commit((shared) => ({
      ...shared,
      exportPresets: upsert(shared.exportPresets, preset),
    }));
    return preset;
  }

  removeExportPreset(presetId: PresetId): void {
    this.commit((shared) => {
      if (shared.exportPresets.length <= 1) {
        throw new IpcError('invalid_argument', 'at least one export preset must remain');
      }
      const remaining = shared.exportPresets.filter((preset) => preset.id !== presetId);
      if (remaining.length === shared.exportPresets.length) return shared;
      return {
        ...shared,
        exportPresets: remaining,
        ...(shared.activePresetId === presetId ? { activePresetId: remaining[0]?.id } : {}),
      };
    });
  }

  // -------------------------------------------------------------- settings folder

  folderInfo(): SettingsFolderInfo {
    const hasSettings = this.file !== undefined && existsSync(this.sharedFileAt(this.folder));
    const problem = this.writeProblem;
    return {
      path: this.folder,
      defaultPath: this.defaultFolder,
      isDefault: this.folder === this.defaultFolder,
      hasSettings,
      ...(problem === undefined ? {} : { problem }),
    };
  }

  inspectFolder(path: string): SettingsFolderChoice {
    if (!isAbsolute(path)) {
      throw new IpcError('invalid_argument', 'the settings folder must be an absolute path');
    }
    const problem = this.checkFolder(path);
    if (problem !== undefined) return { path, hasSettings: false, problem };
    const file = this.sharedFileAt(path);
    if (!existsSync(file)) return { path, hasSettings: false };
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObject(parsed)) throw new Error('not a settings object');
    } catch (error) {
      return {
        path,
        hasSettings: true,
        problem:
          `The settings file in "${path}" could not be read (${messageOf(error)}). ` +
          'Nothing was written. It may be half-synced or a conflict copy.',
      };
    }
    return { path, hasSettings: true };
  }

  /** Use the settings in `path`; an empty folder starts from the defaults. */
  useFolder(path: string): SettingsFolderInfo {
    this.assertFolderPath(path);
    if (path === this.folder) {
      // A drive that was missing at start is looked at again when the user chooses it.
      this.problem = this.checkFolder(path);
      if (this.problem === undefined) {
        this.newerVersion = undefined;
        this.unreadableFile = undefined;
        const loaded = existsSync(this.sharedFileAt(path))
          ? this.loadSharedFile(path, this.machine)
          : splitSettings(this.defaultState(), path, this.machine, newId);
        this.shared = loaded.shared;
        this.machine = loaded.machine;
      }
      return this.folderInfo();
    }
    const problem = this.checkFolder(path);
    if (problem !== undefined) throw new IpcError('io', problem);
    const previousNewer = this.newerVersion;
    const previousUnreadable = this.unreadableFile;
    this.newerVersion = undefined;
    this.unreadableFile = undefined;
    const loaded = existsSync(this.sharedFileAt(path))
      ? this.loadSharedFile(path, this.machine)
      : splitSettings(this.defaultState(), path, this.machine, newId);
    if (this.unreadableFile !== undefined) {
      const message = this.unreadableFile;
      this.newerVersion = previousNewer;
      this.unreadableFile = previousUnreadable;
      throw new IpcError('io', message);
    }
    const machine: MachineSettings = {
      ...loaded.machine,
      ...(path === this.defaultFolder ? {} : { settingsFolder: path }),
    };
    if (path === this.defaultFolder) delete machine.settingsFolder;
    if (this.machineFile !== undefined) {
      writeJsonAtomic(this.machineFile, machineFileContents(machine));
    }
    if (!existsSync(this.sharedFileAt(path))) {
      writeJsonAtomic(this.sharedFileAt(path), sharedFileContents(loaded.shared));
    }
    this.folder = path;
    this.problem = undefined;
    this.shared = loaded.shared;
    this.machine = machine;
    this.lastSharedRaw = existsSync(this.sharedFileAt(path))
      ? readFileSync(this.sharedFileAt(path), 'utf8')
      : undefined;
    return this.folderInfo();
  }

  /**
   * Copy the shared settings and imported presets into an empty folder, then use it.
   * Nothing is moved or deleted from the folder in use now.
   */
  copyToFolder(path: string): SettingsFolderInfo {
    this.assertFolderPath(path);
    const problem = this.checkFolder(path);
    if (problem !== undefined) throw new IpcError('io', problem);
    if (this.newerVersion !== undefined) throw new IpcError('io', this.newerVersion);
    if (this.unreadableFile !== undefined) throw new IpcError('io', this.unreadableFile);
    if (existsSync(this.sharedFileAt(path))) {
      throw new IpcError(
        'invalid_argument',
        `"${path}" already has settings. Use them instead of copying.`,
      );
    }
    const source = this.readLatestShared();
    this.copyPresets(path);
    writeJsonAtomic(this.sharedFileAt(path), sharedFileContents(source));
    const machine: MachineSettings = {
      ...this.machine,
      ...(path === this.defaultFolder ? {} : { settingsFolder: path }),
    };
    if (path === this.defaultFolder) delete machine.settingsFolder;
    if (this.machineFile !== undefined) {
      writeJsonAtomic(this.machineFile, machineFileContents(machine));
    }
    this.folder = path;
    this.problem = undefined;
    this.shared = source;
    this.machine = machine;
    this.lastSharedRaw = readFileSync(this.sharedFileAt(path), 'utf8');
    return this.folderInfo();
  }

  /** Where imported develop presets live: `<settings folder>/presets`. */
  presetsDir(): string {
    return this.folder === '' ? '' : join(this.folder, 'presets');
  }

  private assertFolderPath(path: string): void {
    if (!isAbsolute(path)) {
      throw new IpcError('invalid_argument', 'the settings folder must be an absolute path');
    }
  }

  private readLatestShared(): SharedSettings {
    if (this.file === undefined) return this.shared;
    if (this.newerVersion !== undefined) throw new IpcError('io', this.newerVersion);
    if (this.unreadableFile !== undefined) throw new IpcError('io', this.unreadableFile);
    const file = this.currentSharedFile();
    if (!existsSync(file)) return this.shared;
    const raw = readFileSync(file, 'utf8');
    if (raw === this.lastSharedRaw) return this.shared;
    const loaded = this.sharedFromRaw(raw, this.folder, this.machine);
    if (loaded === undefined) {
      throw new IpcError('io', 'settings.json could not be read; nothing was copied');
    }
    return loaded.shared;
  }

  /** The shared half of a file on disk, without writing anything. */
  private sharedFromRaw(
    raw: string,
    folder: string,
    machine: MachineSettings,
  ): { shared: SharedSettings; machine: MachineSettings } | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (isSharedSettingsFile(parsed)) {
      return { shared: normalizeSharedFile(parsed, this.defaults), machine };
    }
    if (!isObject(parsed)) return undefined;
    const legacy = readLegacySettings(parsed, this.defaults);
    return splitSettings(
      { settings: legacy.settings, sources: legacy.sources, destinations: legacy.destinations },
      folder,
      this.machineExisted ? machine : undefined,
      newId,
    );
  }

  private copyPresets(target: string): void {
    if (this.folder === '') return;
    const from = join(this.folder, 'presets');
    if (!existsSync(from)) return;
    const to = join(target, 'presets');
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (!PRESET_FILE.test(name)) continue;
      const destination = join(to, name);
      if (existsSync(destination)) continue;
      copyFileSync(join(from, name), destination);
    }
  }
}

function newId(): string {
  return randomUUID();
}

function assertId(id: string): void {
  if (typeof id !== 'string' || id === '') {
    throw new IpcError('invalid_argument', 'id is required');
  }
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((existing, i) => (i === index ? item : existing));
}
