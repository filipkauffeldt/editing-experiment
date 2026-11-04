// @vitest-environment node
import { asDestinationId, asPresetId, asSourceId, type FolderDestination } from '@ee/contracts';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultSettings } from '../src/shared/settings';
import { hostFor } from '../src/shared/routing';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-settings-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const defaults = defaultSettings('/home/test');
const desk: FolderDestination = {
  id: asDestinationId('desk'),
  name: 'Desk',
  kind: 'folder',
  path: '/out',
  remotePathTemplate: '{fileName}',
};

describe('SettingsStore profile folders', () => {
  it('keeps the folders the user added across a restart, without repeats', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    expect(store.get().profileFolders).toBeUndefined();
    store.set({ profileFolders: ['/profiles/a', '/profiles/b', '/profiles/a'] });
    expect(store.get().profileFolders).toEqual(['/profiles/a', '/profiles/b']);
    expect(new SettingsStore(file, defaults).get().profileFolders).toEqual([
      '/profiles/a',
      '/profiles/b',
    ]);
    expect(() => store.set({ profileFolders: [''] })).toThrow(/profileFolders/);
  });
});

describe('SettingsStore metadata templates', () => {
  it('round-trips the global template and code replacement lists without repeats', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    expect(store.get().metadataTemplates).toEqual([]);
    expect(store.get().codeReplacementPaths).toEqual([]);

    store.set({
      metadataTemplates: ['/templates/a.XMP', '/templates/b.XMP', '/templates/a.XMP'],
      codeReplacementPaths: ['/codes/a.txt', '/codes/b.txt', '/codes/a.txt'],
    });
    expect(store.get().metadataTemplates).toEqual(['/templates/a.XMP', '/templates/b.XMP']);
    expect(store.get().codeReplacementPaths).toEqual(['/codes/a.txt', '/codes/b.txt']);
    expect(new SettingsStore(file, defaults).get()).toMatchObject({
      metadataTemplates: ['/templates/a.XMP', '/templates/b.XMP'],
      codeReplacementPaths: ['/codes/a.txt', '/codes/b.txt'],
    });
    expect(() => store.set({ metadataTemplates: [''] })).toThrow(/metadataTemplates/);
    expect(() => store.set({ codeReplacementPaths: [''] })).toThrow(/codeReplacementPaths/);
  });

  it('migrates the ingest template and code replacement files to the global lists', async () => {
    const dir = await tempDir();
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        ingest: {
          destination: { path: '/ingest' },
          renameTemplate: '{date}',
          metadataTemplatePath: '/templates/ingest.XMP',
          metadataTemplateMode: 'fillEmpty',
          codeReplacementPaths: ['/codes/old.txt'],
        },
        sources: [],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    expect(store.get().metadataTemplates).toEqual(['/templates/ingest.XMP']);
    expect(store.get().codeReplacementPaths).toEqual(['/codes/old.txt']);
    expect(store.get().ingest.metadataTemplatePath).toBe('/templates/ingest.XMP');
    expect(store.get().ingest.metadataTemplateMode).toBe('fillEmpty');

    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      ingest: Record<string, unknown>;
      metadataTemplates: string[];
      codeReplacementPaths: string[];
    };
    expect(saved.metadataTemplates).toEqual(['/templates/ingest.XMP']);
    expect(saved.codeReplacementPaths).toEqual(['/codes/old.txt']);
    expect(saved.ingest.codeReplacementPaths).toBeUndefined();
    expect(saved.ingest.metadataTemplatePath).toBe('/templates/ingest.XMP');
  });
});

describe('SettingsStore copy selections', () => {
  it('round-trips the last confirmed selections through the settings file', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    expect(store.get().copyMetadataFields).toBeUndefined();
    expect(store.get().copySettingGroups).toBeUndefined();

    store.set({
      copyMetadataFields: ['headline', 'city', 'headline'],
      copySettingGroups: ['basicTone', 'crop'],
    });
    expect(store.get().copyMetadataFields).toEqual(['headline', 'city']);
    expect(store.get().copySettingGroups).toEqual(['basicTone', 'crop']);

    const reopened = new SettingsStore(file, defaults);
    expect(reopened.get().copyMetadataFields).toEqual(['headline', 'city']);
    expect(reopened.get().copySettingGroups).toEqual(['basicTone', 'crop']);
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(saved.copyMetadataFields).toEqual(['headline', 'city']);
    expect(saved.copySettingGroups).toEqual(['basicTone', 'crop']);
  });

  it('keeps an empty confirmed selection distinct from nothing remembered', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    store.set({ copyMetadataFields: [], copySettingGroups: [] });

    const reopened = new SettingsStore(file, defaults);
    expect(reopened.get().copyMetadataFields).toEqual([]);
    expect(reopened.get().copySettingGroups).toEqual([]);
  });

  it('loads settings written before the selections existed with nothing remembered', async () => {
    const file = join(await tempDir(), 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        ingest: {
          destination: { path: '/ingest' },
          renameTemplate: '{date}',
          metadataTemplateMode: 'replace',
          fileNaming: 'rename',
        },
        exportRoot: '/exports',
        exportPresets: defaults.exportPresets,
        activePresetId: defaults.activePresetId,
        metadataTemplates: ['/templates/a.XMP'],
        codeReplacementPaths: [],
        sources: [],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    expect(store.get().copyMetadataFields).toBeUndefined();
    expect(store.get().copySettingGroups).toBeUndefined();
    expect(store.get().metadataTemplates).toEqual(['/templates/a.XMP']);
  });

  it('drops field keys and groups that no longer exist', async () => {
    const file = join(await tempDir(), 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        ...defaults,
        copyMetadataFields: ['headline', 'retiredField', 'city'],
        copySettingGroups: ['detail', 'retiredGroup'],
        sources: [],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    expect(store.get().copyMetadataFields).toEqual(['headline', 'city']);
    expect(store.get().copySettingGroups).toEqual(['detail']);
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(saved.copyMetadataFields).toEqual(['headline', 'city']);
    expect(saved.copySettingGroups).toEqual(['detail']);
  });

  it('reads corrupt stored selections as nothing remembered instead of failing', async () => {
    const file = join(await tempDir(), 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        ...defaults,
        copyMetadataFields: 'headline',
        copySettingGroups: { id: 'detail' },
        sources: [],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    expect(store.get().copyMetadataFields).toBeUndefined();
    expect(store.get().copySettingGroups).toBeUndefined();
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(saved.copyMetadataFields).toBeUndefined();
    expect(saved.copySettingGroups).toBeUndefined();
  });

  it('rejects a malformed selection passed to settings:set', () => {
    const store = new SettingsStore(undefined, defaults);
    expect(() => store.set({ copyMetadataFields: 'headline' as never })).toThrow(
      /copyMetadataFields/,
    );
    expect(() => store.set({ copySettingGroups: [1] as never })).toThrow(/copySettingGroups/);
  });
});

describe('SettingsStore file naming', () => {
  it('defaults to rename for a fresh install', () => {
    const store = new SettingsStore(undefined, defaults);
    expect(store.get().ingest.fileNaming).toBe('rename');
    expect(store.get().exportPresets[0]?.fileNaming).toBe('rename');
  });

  it('migrates settings written before the choice to rename and keeps the templates', async () => {
    const file = join(await tempDir(), 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        ingest: {
          destination: { path: '/ingest' },
          renameTemplate: '{date}_{event}',
        },
        exportPresets: [
          {
            id: 'old',
            name: 'Old',
            folderTemplate: '{folder}',
            fileNameTemplate: '{filenamebase}-{event}',
            ifExists: 'suffix',
            format: 'jpeg',
            quality: 90,
            colorSpace: 'srgb',
            resize: { mode: 'none' },
            outputSharpening: { target: 'none', amount: 'standard' },
            metadata: 'all',
            stripGps: false,
            version: 'top',
            sendTo: [],
          },
        ],
        sources: [],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    expect(store.get().ingest).toMatchObject({
      fileNaming: 'rename',
      renameTemplate: '{date}_{event}',
    });
    expect(store.get().exportPresets[0]).toMatchObject({
      fileNaming: 'rename',
      fileNameTemplate: '{filenamebase}-{event}',
    });

    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      ingest: Record<string, unknown>;
      exportPresets: Array<Record<string, unknown>>;
    };
    expect(saved.ingest.fileNaming).toBe('rename');
    expect(saved.exportPresets[0]?.fileNaming).toBe('rename');
  });

  it('round-trips keep-original and retains each template when switching back', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    const keptPreset = {
      ...defaults.exportPresets[0]!,
      fileNaming: 'keep' as const,
    };
    store.set({ ingest: { ...defaults.ingest, fileNaming: 'keep' } });
    store.saveExportPreset(keptPreset);

    let reopened = new SettingsStore(file, defaults);
    expect(reopened.get().ingest).toMatchObject({
      fileNaming: 'keep',
      renameTemplate: defaults.ingest.renameTemplate,
    });
    expect(reopened.get().exportPresets[0]).toMatchObject({
      fileNaming: 'keep',
      fileNameTemplate: defaults.exportPresets[0]!.fileNameTemplate,
    });

    // Switching back still has the template the user wrote before.
    reopened.set({
      ingest: {
        ...reopened.get().ingest,
        fileNaming: 'rename',
        renameTemplate: '{event}_{seq:3}',
      },
    });
    reopened.saveExportPreset({
      ...reopened.get().exportPresets[0]!,
      fileNaming: 'rename',
      fileNameTemplate: '{filenamebase}-{event}',
    });

    reopened = new SettingsStore(file, defaults);
    expect(reopened.get().ingest).toMatchObject({
      fileNaming: 'rename',
      renameTemplate: '{event}_{seq:3}',
    });
    expect(reopened.get().exportPresets[0]).toMatchObject({
      fileNaming: 'rename',
      fileNameTemplate: '{filenamebase}-{event}',
    });
  });

  it('requires a template only while renaming', () => {
    const store = new SettingsStore(undefined, defaults);
    expect(() =>
      store.set({ ingest: { ...defaults.ingest, fileNaming: 'rename', renameTemplate: ' ' } }),
    ).toThrowError(/rename template/);
    expect(() =>
      store.saveExportPreset({
        ...defaults.exportPresets[0]!,
        fileNaming: 'rename',
        fileNameTemplate: ' ',
      }),
    ).toThrowError(/export presets/);

    store.set({ ingest: { ...defaults.ingest, fileNaming: 'keep', renameTemplate: '' } });
    store.saveExportPreset({
      ...defaults.exportPresets[0]!,
      fileNaming: 'keep',
      fileNameTemplate: '',
    });
    expect(store.get().ingest.fileNaming).toBe('keep');
    expect(store.get().exportPresets[0]?.fileNameTemplate).toBe('');
  });
});

describe('SettingsStore', () => {
  it('starts from defaults and survives a restart', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    expect(store.get()).toEqual(defaults);

    store.set({ ingest: { ...defaults.ingest, renameTemplate: '{seq:5}' } });
    store.saveSource({ id: asSourceId('s1'), name: 'S1', kind: 'folder', path: '/cards/a' });
    store.saveDestination(desk);
    const preset = {
      ...defaults.exportPresets[0]!,
      name: 'Sportfotografen FTP',
      quality: 70,
      sendTo: [desk.id],
    };
    store.saveExportPreset(preset);
    store.set({ activePresetId: preset.id });

    const reopened = new SettingsStore(file, defaults);
    expect(reopened.get().ingest.renameTemplate).toBe('{seq:5}');
    expect(reopened.get().activePresetId).toBe(preset.id);
    expect(reopened.listExportPresets().find((item) => item.id === preset.id)).toMatchObject({
      quality: 70,
      sendTo: [desk.id],
    });
    expect(reopened.listSources().map((s) => s.id)).toEqual(['s1']);
    expect(reopened.listDestinations()).toEqual([desk]);
  });

  it('defaults the ingest template mode to replace and round-trips the other mode', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    expect(store.get().ingest.metadataTemplateMode).toBe('replace');

    store.set({ ingest: { ...defaults.ingest, metadataTemplateMode: 'fillEmpty' } });
    const reopened = new SettingsStore(file, defaults);
    expect(reopened.get().ingest.metadataTemplateMode).toBe('fillEmpty');
  });

  it('round-trips the local ingest filters on card and folder sources', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    store.saveSource({
      id: asSourceId('card'),
      kind: 'card',
      name: 'Card',
      mountPath: '/cards/a',
      fileTypes: 'raw',
      lockFilter: 'locked',
      incremental: false,
    });
    store.saveSource({
      id: asSourceId('folder'),
      kind: 'folder',
      name: 'Folder',
      path: '/cards/b',
      fileTypes: 'jpeg',
      lockFilter: 'unlocked',
      incremental: true,
    });

    const reopened = new SettingsStore(file, defaults);
    expect(reopened.listSources()).toMatchObject([
      { id: 'card', fileTypes: 'raw', lockFilter: 'locked', incremental: false },
      { id: 'folder', fileTypes: 'jpeg', lockFilter: 'unlocked', incremental: true },
    ]);
  });

  it('migrates the old lockedOnly boolean to lockFilter and drops the old key', async () => {
    const dir = await tempDir();
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        ingest: {
          destination: { path: '/ingest' },
          renameTemplate: '{date}',
        },
        sources: [
          {
            id: 'locked-card',
            kind: 'card',
            name: 'Locked',
            mountPath: '/cards/a',
            lockedOnly: true,
          },
          {
            id: 'unlocked-folder',
            kind: 'folder',
            name: 'Unlocked',
            path: '/cards/b',
            lockedOnly: false,
          },
        ],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    expect(store.listSources()).toMatchObject([
      { id: 'locked-card', lockFilter: 'locked' },
      { id: 'unlocked-folder' },
    ]);
    expect(store.listSources().some((source) => 'lockedOnly' in source)).toBe(false);

    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(saved.sources[0]?.lockFilter).toBe('locked');
    expect(saved.sources[1]?.lockFilter).toBeUndefined();
    expect(saved.sources.some((source) => 'lockedOnly' in source)).toBe(false);
  });

  it('migrates settings written before the template mode existed to replace', async () => {
    const dir = await tempDir();
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        ingest: {
          destination: { path: '/ingest' },
          renameTemplate: '{date}',
        },
        sources: [],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    expect(store.get().ingest.metadataTemplateMode).toBe('replace');
    expect(JSON.parse(await readFile(file, 'utf8')).ingest.metadataTemplateMode).toBe('replace');
  });

  it('migrates a legacy finishAction into a default preset on first load', async () => {
    const dir = await tempDir();
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        ingest: {
          destination: { path: '/ingest' },
          renameTemplate: '{date}',
        },
        finishAction: {
          exportPreset: { maxEdge: 3000, quality: 76, metadata: 'iptc' },
          destinations: ['desk'],
        },
        sources: [],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    const migrated = store.listExportPresets();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({
      id: 'migrated-default',
      name: 'Default',
      quality: 76,
      metadata: 'iptc',
      resize: { mode: 'longEdge', pixels: 3000 },
      sendTo: ['desk'],
    });
    expect(store.get().activePresetId).toBe(asPresetId('migrated-default'));

    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.finishAction).toBeUndefined();
    expect(saved.exportPresets[0].id).toBe('migrated-default');
    expect(saved.activePresetId).toBe('migrated-default');
  });

  it('upserts by id and drops a removed destination from every preset', async () => {
    const store = new SettingsStore(undefined, defaults);
    store.saveDestination(desk);
    store.saveDestination({ ...desk, name: 'Renamed' });
    expect(store.listDestinations()).toHaveLength(1);
    expect(store.listDestinations()[0]?.name).toBe('Renamed');
    store.saveExportPreset({ ...defaults.exportPresets[0]!, sendTo: [desk.id] });
    store.removeDestination(desk.id);
    expect(store.listExportPresets().every((preset) => preset.sendTo.length === 0)).toBe(true);
  });

  it('refuses to remove the last preset and keeps the active preset valid', () => {
    const store = new SettingsStore(undefined, defaults);
    const second = {
      ...defaults.exportPresets[0]!,
      id: asPresetId('second'),
      name: 'Second',
    };
    store.saveExportPreset(second);
    store.set({ activePresetId: second.id });
    store.removeExportPreset(second.id);
    expect(store.listExportPresets().map((preset) => preset.id)).toEqual([
      defaults.exportPresets[0]!.id,
    ]);
    expect(store.get().activePresetId).toBe(defaults.exportPresets[0]!.id);
    expect(() => store.removeExportPreset(defaults.exportPresets[0]!.id)).toThrowError(
      /at least one/,
    );
  });

  it('shallow-merges settings:set and rejects malformed values', () => {
    const store = new SettingsStore(undefined, defaults);
    store.set({ ingest: { ...defaults.ingest, renameTemplate: 'x' } });
    expect(store.get().exportPresets).toEqual(defaults.exportPresets);
    expect(() => store.set({ ingest: { renameTemplate: 'x' } as never })).toThrowError(
      /destination/,
    );
    expect(() => store.set({ exportPresets: [] })).toThrowError(/non-empty/);
    expect(() =>
      store.saveExportPreset({ ...defaults.exportPresets[0]!, quality: 500 }),
    ).toThrowError(/quality|export presets/);
    expect(() =>
      store.saveExportPreset({ ...defaults.exportPresets[0]!, format: 'tiff' as never }),
    ).toThrowError(/export presets/);
  });

  it('rejects a develop-only preset that has send targets', () => {
    const store = new SettingsStore(undefined, defaults);
    expect(() =>
      store.saveExportPreset({
        ...defaults.exportPresets[0]!,
        id: asPresetId('develop-only'),
        version: 'develop',
        sendTo: [desk.id],
      }),
    ).toThrowError(/develop-only/);
  });

  it('sets a corrupt file aside, warns, and starts from defaults', async () => {
    const dir = await tempDir();
    const file = join(dir, 'settings.json');
    await writeFile(file, '{ not json');
    const warnings: string[] = [];
    const store = new SettingsStore(file, defaults, (message) => warnings.push(message));
    expect(store.get()).toEqual(defaults);
    expect(warnings).toHaveLength(1);
    const files = await readdir(dir);
    expect(files.some((name) => name.startsWith('settings.json.corrupt-'))).toBe(true);
    store.saveSource({ id: asSourceId('s'), name: 'S', kind: 'folder', path: '/x' });
    expect(JSON.parse(await readFile(file, 'utf8')).sources).toHaveLength(1);
  });
});

describe('routing', () => {
  it('keeps mock settings in main and serves real settings from the jobs process', () => {
    expect(hostFor('settings:get', { mock: true })).toBe('main');
    expect(hostFor('settings:get', { mock: false })).toBe('jobs');
    expect(hostFor('credentials:set', { mock: false })).toBe('main');
    expect(hostFor('dialog:pick', { mock: false })).toBe('main');
    expect(hostFor('ingest:start', { mock: false })).toBe('jobs');
    expect(hostFor('exportPresets:list', { mock: false })).toBe('jobs');
  });
});
