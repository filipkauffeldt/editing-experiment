// @vitest-environment node
import { asDestinationId, asSourceId, type FolderDestination } from '@ee/contracts';
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

describe('SettingsStore', () => {
  it('starts from defaults and survives a restart', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    expect(store.get()).toEqual(defaults);

    store.set({ ingest: { ...defaults.ingest, renameTemplate: '{seq:5}' } });
    store.saveSource({ id: asSourceId('s1'), name: 'S1', kind: 'folder', path: '/cards/a' });
    store.saveDestination(desk);
    store.set({
      finishAction: { exportPreset: { quality: 70, metadata: 'iptc' }, destinations: [desk.id] },
    });

    const reopened = new SettingsStore(file, defaults);
    expect(reopened.get().ingest.renameTemplate).toBe('{seq:5}');
    expect(reopened.get().finishAction.exportPreset.quality).toBe(70);
    expect(reopened.listSources().map((s) => s.id)).toEqual(['s1']);
    expect(reopened.listDestinations()).toEqual([desk]);
  });

  it('upserts by id and drops a removed destination from the finish action', async () => {
    const store = new SettingsStore(undefined, defaults);
    store.saveDestination(desk);
    store.saveDestination({ ...desk, name: 'Renamed' });
    expect(store.listDestinations()).toHaveLength(1);
    expect(store.listDestinations()[0]?.name).toBe('Renamed');
    store.set({
      finishAction: { exportPreset: { quality: 90, metadata: 'all' }, destinations: [desk.id] },
    });
    store.removeDestination(desk.id);
    expect(store.get().finishAction.destinations).toEqual([]);
  });

  it('shallow-merges settings:set and rejects malformed values', () => {
    const store = new SettingsStore(undefined, defaults);
    store.set({ ingest: { ...defaults.ingest, renameTemplate: 'x' } });
    expect(store.get().finishAction).toEqual(defaults.finishAction);
    expect(() => store.set({ ingest: { renameTemplate: 'x' } as never })).toThrowError(
      /destination/,
    );
    expect(() => store.set({ finishAction: {} as never })).toThrowError(/exportPreset/);
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
  });
});
