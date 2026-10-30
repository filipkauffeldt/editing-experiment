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
          codeReplacementPaths: [],
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
