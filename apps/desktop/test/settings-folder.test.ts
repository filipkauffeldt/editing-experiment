// @vitest-environment node
import {
  IpcError,
  asDestinationId,
  asSourceId,
  type FtpDestination,
  type FtpSource,
  type FolderDestination,
  type IpcHandlers,
  type SourceConfig,
} from '@ee/contracts';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/jobs/backend/backend';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultPanelWidths } from '../src/shared/panel-widths';
import { defaultSettings } from '../src/shared/settings';
import { startFtpServer } from './helpers/ftp-server';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-settings-folder-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const defaults = defaultSettings('/home/test');
const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

const ftpSource: FtpSource = {
  id: asSourceId('pool'),
  kind: 'ftp',
  name: 'Pool FTP',
  host: 'ftp.sportfotografen.se',
  port: 21,
  username: 'photographer',
  credentialRef: 'cred-pool',
  remotePath: '/incoming',
  pollIntervalMs: 5000,
  deleteAfterDownload: false,
  security: 'none',
};

const ftpDestination: FtpDestination = {
  id: asDestinationId('desk'),
  kind: 'ftp',
  name: 'Desk FTP',
  host: 'ftp.sportfotografen.se',
  port: 21,
  username: 'ftpuser',
  credentialRef: 'cred-desk',
  remotePathTemplate: '/incoming/{fileName}',
  security: 'none',
};

const folderDestination: FolderDestination = {
  id: asDestinationId('outbox'),
  kind: 'folder',
  name: 'Outbox',
  path: '/outbox',
  remotePathTemplate: '{fileName}',
};

describe('settings folder migration', () => {
  it('splits an old settings.json without losing anything and keeps the old file', async () => {
    const userData = await tempDir();
    const file = join(userData, 'settings.json');
    const template = join(userData, 'templates', 'ingest.XMP');
    const old = {
      version: 2,
      ingest: {
        destination: { path: '/machine/photos', subfolderTemplate: '{date}/{sourceName}' },
        backupDestination: { path: '/machine/backup' },
        fileNaming: 'rename',
        renameTemplate: '{date}_{seq:4}',
        metadataTemplatePath: template,
        metadataTemplateMode: 'fillEmpty',
        developPresetId: 'lr-preset',
      },
      exportRoot: '/machine/exports',
      exportPresets: [
        {
          ...defaults.exportPresets[0],
          id: 'press',
          name: 'Press',
          sendTo: ['desk'],
        },
      ],
      activePresetId: 'press',
      profileFolders: ['/machine/profiles'],
      presetFolders: ['/machine/presets'],
      metadataTemplates: [template, '/machine/other.XMP'],
      codeReplacementPaths: ['/machine/codes.txt'],
      copyMetadataFields: ['headline', 'city'],
      copySettingGroups: ['basicTone'],
      panelWidths: defaultPanelWidths(),
      sources: [ftpSource, { id: 'card', kind: 'folder', name: 'Card', path: '/machine/card' }],
      destinations: [ftpDestination, folderDestination],
    };
    const oldText = JSON.stringify(old, null, 2);
    await writeFile(file, oldText);

    const store = new SettingsStore(file, defaults);

    expect(store.get()).toMatchObject({
      ingest: {
        destination: { path: '/machine/photos', subfolderTemplate: '{date}/{sourceName}' },
        backupDestination: { path: '/machine/backup' },
        renameTemplate: '{date}_{seq:4}',
        metadataTemplatePath: template,
        metadataTemplateMode: 'fillEmpty',
        developPresetId: 'lr-preset',
      },
      exportRoot: '/machine/exports',
      activePresetId: 'press',
      profileFolders: ['/machine/profiles'],
      presetFolders: ['/machine/presets'],
      metadataTemplates: [template, '/machine/other.XMP'],
      codeReplacementPaths: ['/machine/codes.txt'],
      copyMetadataFields: ['headline', 'city'],
      copySettingGroups: ['basicTone'],
      panelWidths: defaultPanelWidths(),
    });
    expect(store.listSources().map((source) => source.id)).toEqual(['card', 'pool']);
    expect(store.listDestinations().map((destination) => destination.id)).toEqual([
      'outbox',
      'desk',
    ]);

    const shared = await readJson(file);
    expect(shared.version).toBe(3);
    expect(shared.format).toBe('ee-settings-folder');
    expect(shared.sources).toMatchObject([{ id: 'pool' }]);
    expect(shared.destinations).toMatchObject([{ id: 'desk' }]);
    expect(shared.exportRoot).toBeUndefined();
    expect(shared.panelWidths).toBeUndefined();
    expect(shared.metadataTemplates).toEqual([
      { folder: 'templates/ingest.XMP' },
      { machine: expect.any(String) },
    ]);
    expect(shared.ingest).toMatchObject({
      fileNaming: 'rename',
      renameTemplate: '{date}_{seq:4}',
      metadataTemplateMode: 'fillEmpty',
      metadataTemplate: { folder: 'templates/ingest.XMP' },
    });
    expect(shared.ingest).toMatchObject({
      destination: { subfolderTemplate: '{date}/{sourceName}' },
    });
    expect(
      (shared.ingest as { destination: Record<string, unknown> }).destination,
    ).not.toHaveProperty('path');

    const machine = await readJson(join(userData, 'machine.json'));
    expect(machine).toMatchObject({
      ingest: {
        destinationPath: '/machine/photos',
        backupDestinationPath: '/machine/backup',
      },
      exportRoot: '/machine/exports',
      profileFolders: ['/machine/profiles'],
      presetFolders: ['/machine/presets'],
      panelWidths: defaultPanelWidths(),
      sources: [{ id: 'card', kind: 'folder', path: '/machine/card' }],
      destinations: [{ id: 'outbox', kind: 'folder', path: '/outbox' }],
    });
    expect(Object.values(machine.paths as Record<string, string>)).toEqual(
      expect.arrayContaining(['/machine/other.XMP', '/machine/codes.txt']),
    );
    expect(Object.values(machine.paths as Record<string, string>)).not.toContain(template);
    expect(machine.settingsFolder).toBeUndefined();

    expect(await readFile(`${file}.pre-settings-folder`, 'utf8')).toBe(oldText);
  });

  it('recovers a split that was interrupted after the backup was made', async () => {
    const userData = await tempDir();
    const file = join(userData, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        ingest: {
          destination: { path: '/machine/photos' },
          renameTemplate: '{date}',
        },
        copyMetadataFields: ['headline'],
        sources: [],
        destinations: [],
      }),
    );
    // Migrate once so the backup and the machine file exist.
    const first = new SettingsStore(file, defaults);
    expect(first.get().copyMetadataFields).toEqual(['headline']);
    const sharedText = await readFile(file, 'utf8');
    // Simulate a crash between writing the new file and renaming it into place.
    await unlink(file);
    await writeFile(`${file}.migrating`, sharedText);

    const recovered = new SettingsStore(file, defaults);
    expect(recovered.get().copyMetadataFields).toEqual(['headline']);
    expect(recovered.get().ingest.destination.path).toBe('/machine/photos');
    expect(await readFile(file, 'utf8')).toBe(sharedText);
    expect((await readdir(userData)).some((name) => name.startsWith('settings.json.pre-'))).toBe(
      true,
    );
  });

  it('re-splits when the crash left the old file and the machine file only', async () => {
    const userData = await tempDir();
    const file = join(userData, 'settings.json');
    const oldText = JSON.stringify({
      version: 2,
      ingest: { destination: { path: '/machine/photos' }, renameTemplate: '{date}' },
      exportRoot: '/machine/exports',
      copyMetadataFields: ['city'],
      sources: [],
      destinations: [],
    });
    await writeFile(file, oldText);
    // A machine file written but the old file not retired yet.
    await writeFile(
      join(userData, 'machine.json'),
      JSON.stringify({
        version: 1,
        format: 'ee-machine',
        ingest: { destinationPath: '/machine/photos' },
        exportRoot: '/machine/exports',
        paths: {},
        sources: [],
        destinations: [],
      }),
    );

    const store = new SettingsStore(file, defaults);
    expect(store.get().copyMetadataFields).toEqual(['city']);
    expect(store.get().ingest.destination.path).toBe('/machine/photos');
    expect((await readJson(file)).format).toBe('ee-settings-folder');
    expect(await readFile(`${file}.pre-settings-folder`, 'utf8')).toBe(oldText);
  });
});

describe('two computers and one settings folder', () => {
  it('sees the other computer after a restart and keeps paths per machine', async () => {
    const root = await tempDir();
    const userDataA = join(root, 'userdata-a');
    const userDataB = join(root, 'userdata-b');
    const folder = join(root, 'settings');
    await Promise.all([mkdir(userDataA), mkdir(userDataB), mkdir(folder)]);

    const a = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    a.useFolder(folder);
    a.saveSource(ftpSource);
    a.saveSource({ id: asSourceId('card-a'), kind: 'folder', name: 'Card A', path: '/card/a' });
    a.saveDestination(ftpDestination);
    a.saveExportPreset({ ...defaults.exportPresets[0]!, sendTo: [ftpDestination.id] });
    a.set({ copyMetadataFields: ['headline'] });

    const b = new SettingsStore(join(userDataB, 'settings.json'), defaults);
    b.useFolder(folder);
    expect(b.listSources().map((source) => source.id)).toEqual(['pool']);
    expect(b.listDestinations().map((destination) => destination.id)).toEqual(['desk']);
    expect(b.get().ingest.destination.path).toBe(defaults.ingest.destination.path);
    expect(b.get().exportRoot).toBe(defaults.exportRoot);

    b.saveSource({ id: asSourceId('card-b'), kind: 'folder', name: 'Card B', path: '/card/b' });
    b.saveDestination(folderDestination);
    b.set({ copySettingGroups: ['basicTone'] });

    const aAgain = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    expect(aAgain.listSources().map((source) => source.id)).toEqual(['card-a', 'pool']);
    expect(aAgain.listDestinations().map((destination) => destination.id)).toEqual(['desk']);
    expect(aAgain.get().copyMetadataFields).toEqual(['headline']);
    expect(aAgain.get().copySettingGroups).toEqual(['basicTone']);

    const bAgain = new SettingsStore(join(userDataB, 'settings.json'), defaults);
    expect(bAgain.listSources().map((source) => source.id)).toEqual(['card-b', 'pool']);
    expect(bAgain.get().ingest.destination.path).toBe(defaults.ingest.destination.path);
  });

  it('applies one change to a file another computer changed, without overwriting it', async () => {
    const root = await tempDir();
    const userDataA = join(root, 'userdata-a');
    const userDataB = join(root, 'userdata-b');
    const folder = join(root, 'settings');
    await Promise.all([mkdir(userDataA), mkdir(userDataB), mkdir(folder)]);

    const a = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    a.useFolder(folder);
    const b = new SettingsStore(join(userDataB, 'settings.json'), defaults);
    b.useFolder(folder);

    // B writes while A still holds the state it read at startup.
    b.saveSource(ftpSource);
    b.set({ copyMetadataFields: ['headline'] });

    a.set({ copySettingGroups: ['basicTone'] });
    a.saveSource({ ...ftpSource, id: asSourceId('pool-2'), name: 'Pool 2' });

    const merged = await readJson(join(folder, 'settings.json'));
    expect(merged.copyMetadataFields).toEqual(['headline']);
    expect(merged.copySettingGroups).toEqual(['basicTone']);
    expect(merged.sources).toMatchObject([{ id: 'pool' }, { id: 'pool-2' }]);

    const aAgain = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    expect(aAgain.get().copyMetadataFields).toEqual(['headline']);
    expect(aAgain.get().copySettingGroups).toEqual(['basicTone']);
  });

  it('keeps a template that belongs to the other computer when this one edits the list', async () => {
    const root = await tempDir();
    const userDataA = join(root, 'userdata-a');
    const userDataB = join(root, 'userdata-b');
    const folder = join(root, 'settings');
    await Promise.all([mkdir(userDataA), mkdir(userDataB), mkdir(folder)]);

    const a = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    a.useFolder(folder);
    a.set({
      metadataTemplates: ['/machine/a-only.XMP'],
      codeReplacementPaths: ['/machine/a-only.txt'],
      ingest: { ...defaults.ingest, metadataTemplatePath: '/machine/a-only.XMP' },
    });

    const b = new SettingsStore(join(userDataB, 'settings.json'), defaults);
    b.useFolder(folder);
    // B cannot see A's paths, so its merged lists are empty.
    expect(b.get().metadataTemplates).toEqual([]);
    expect(b.get().ingest.metadataTemplatePath).toBeUndefined();
    // Editing what B can see must not drop A's entries from the shared file.
    b.set({
      metadataTemplates: ['/machine/b-only.XMP'],
      codeReplacementPaths: ['/machine/b-only.txt'],
      ingest: { ...defaults.ingest, renameTemplate: '{seq:3}' },
    });

    const shared = await readJson(join(folder, 'settings.json'));
    expect(shared.metadataTemplates).toHaveLength(2);
    expect(shared.codeReplacementPaths).toHaveLength(2);
    expect(shared.ingest).toHaveProperty('metadataTemplate');

    const aAgain = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    expect(aAgain.get().metadataTemplates).toEqual(['/machine/a-only.XMP']);
    expect(aAgain.get().codeReplacementPaths).toEqual(['/machine/a-only.txt']);
    expect(aAgain.get().ingest.metadataTemplatePath).toBe('/machine/a-only.XMP');
    expect(aAgain.get().ingest.renameTemplate).toBe('{seq:3}');

    const bAgain = new SettingsStore(join(userDataB, 'settings.json'), defaults);
    expect(bAgain.get().metadataTemplates).toEqual(['/machine/b-only.XMP']);
    expect(bAgain.get().codeReplacementPaths).toEqual(['/machine/b-only.txt']);
  });

  it('ignores sync conflict copies and temp files that are not ours', async () => {
    const root = await tempDir();
    const userData = join(root, 'userdata');
    const folder = join(root, 'settings');
    await Promise.all([mkdir(userData), mkdir(folder)]);
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.useFolder(folder);
    store.set({ copyMetadataFields: ['headline'] });

    await writeFile(join(folder, 'settings.sync-conflict-20261115-120000-ABCDEF.json'), '{ nope');
    await writeFile(join(folder, 'settings.json.tmp'), '{ nope');
    await writeFile(join(folder, '~$settings.json'), '{ nope');

    const reopened = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(reopened.get().copyMetadataFields).toEqual(['headline']);
    expect(reopened.folderInfo().problem).toBeUndefined();
  });
});

describe('the shared file on disk', () => {
  it('is not rewritten at start just because this version would serialise it differently', async () => {
    const userData = await tempDir();
    const folder = join(userData, 'synced');
    await mkdir(folder);
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.useFolder(folder);

    const text = JSON.stringify({
      version: 3,
      format: 'ee-settings-folder',
      ingest: {
        fileNaming: 'rename',
        renameTemplate: '{date}',
        metadataTemplateMode: 'replace',
      },
      exportPresets: defaults.exportPresets,
      activePresetId: defaults.activePresetId,
      metadataTemplates: [],
      codeReplacementPaths: [],
      // Normalisation drops the retired field, but reading must not write.
      copyMetadataFields: ['headline', 'retiredField'],
      sources: [],
      destinations: [],
    });
    await writeFile(join(folder, 'settings.json'), text);

    const reopened = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(reopened.get().copyMetadataFields).toEqual(['headline']);
    expect(await readFile(join(folder, 'settings.json'), 'utf8')).toBe(text);

    // A real change writes the normalised file.
    reopened.set({ copySettingGroups: ['detail'] });
    const saved = await readJson(join(folder, 'settings.json'));
    expect(saved.copyMetadataFields).toEqual(['headline']);
    expect(saved.copySettingGroups).toEqual(['detail']);
  });

  it('reads a file from a newer app version but never writes it', async () => {
    const userData = await tempDir();
    const folder = join(userData, 'synced');
    await mkdir(folder);
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.useFolder(folder);
    const text = JSON.stringify({
      version: 4,
      format: 'ee-settings-folder',
      ingest: {
        fileNaming: 'keep',
        renameTemplate: '{old}',
        metadataTemplateMode: 'replace',
      },
      exportPresets: defaults.exportPresets,
      metadataTemplates: [],
      codeReplacementPaths: [],
      sources: [],
      destinations: [],
      futureTop: { keep: true },
    });
    await writeFile(join(folder, 'settings.json'), text);

    const newer = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(newer.get().ingest.fileNaming).toBe('keep');
    expect(newer.folderInfo().problem).toMatch(/newer version of the app/);
    expect(() => newer.set({ copyMetadataFields: ['headline'] })).toThrowError(
      /newer version of the app/,
    );
    const target = join(userData, 'other');
    await mkdir(target);
    expect(() => newer.copyToFolder(target)).toThrowError(/newer version of the app/);
    expect(await readFile(join(folder, 'settings.json'), 'utf8')).toBe(text);
  });

  it('keeps top-level and per-entry fields it does not know when it writes', async () => {
    const userData = await tempDir();
    const folder = join(userData, 'synced');
    await mkdir(folder);
    const preset = { ...defaults.exportPresets[0]!, futurePreset: 'keep' };
    const shared = {
      version: 3,
      format: 'ee-settings-folder',
      futureTop: { keep: true },
      ingest: {
        fileNaming: 'rename',
        renameTemplate: '{date}',
        metadataTemplateMode: 'replace',
        futureIngest: 7,
      },
      exportPresets: [preset],
      activePresetId: preset.id,
      metadataTemplates: [],
      codeReplacementPaths: [],
      sources: [
        {
          id: 'pool',
          kind: 'ftp',
          name: 'Pool',
          host: 'ftp.sportfotografen.se',
          port: 21,
          username: 'photographer',
          credentialRef: 'cred-pool',
          remotePath: '/incoming',
          pollIntervalMs: 5000,
          deleteAfterDownload: false,
          security: 'none',
          watchForNewFiles: true,
          futureSource: 'keep',
        },
      ],
      destinations: [
        {
          id: 'desk',
          kind: 'ftp',
          name: 'Desk',
          host: 'ftp.sportfotografen.se',
          port: 21,
          username: 'ftpuser',
          credentialRef: 'cred-desk',
          remotePathTemplate: '{fileName}',
          security: 'none',
          futureDestination: 'keep',
        },
      ],
    };
    await writeFile(join(folder, 'settings.json'), JSON.stringify(shared));
    await writeFile(
      join(userData, 'machine.json'),
      JSON.stringify({
        version: 1,
        format: 'ee-machine',
        settingsFolder: folder,
        futureMachine: 1,
        ingest: { destinationPath: '/ingest', futureMachineIngest: 2 },
        exportRoot: '/exports',
        paths: {},
        sources: [
          {
            id: 'card',
            kind: 'folder',
            name: 'Card',
            path: '/card',
            watchForNewFiles: true,
            futureFolderSource: 'keep',
          },
        ],
        destinations: [
          {
            id: 'outbox',
            kind: 'folder',
            name: 'Outbox',
            path: '/outbox',
            remotePathTemplate: '{fileName}',
            futureFolderDestination: 'keep',
          },
        ],
      }),
    );

    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.set({ copyMetadataFields: ['headline'], exportRoot: '/new' });

    const savedShared = await readJson(join(folder, 'settings.json'));
    expect(savedShared.futureTop).toEqual({ keep: true });
    expect(savedShared.ingest).toMatchObject({ futureIngest: 7 });
    expect(savedShared.sources).toMatchObject([{ watchForNewFiles: true, futureSource: 'keep' }]);
    expect(savedShared.destinations).toMatchObject([{ futureDestination: 'keep' }]);
    expect((savedShared.exportPresets as Array<Record<string, unknown>>)[0]).toMatchObject({
      futurePreset: 'keep',
    });

    const savedMachine = await readJson(join(userData, 'machine.json'));
    expect(savedMachine.futureMachine).toBe(1);
    expect(savedMachine.ingest).toMatchObject({ futureMachineIngest: 2 });
    expect(savedMachine.sources).toMatchObject([
      { watchForNewFiles: true, futureFolderSource: 'keep' },
    ]);
    expect(savedMachine.destinations).toMatchObject([{ futureFolderDestination: 'keep' }]);
  });

  it('does not move or replace an unreadable file in a synced folder', async () => {
    const userData = await tempDir();
    const folder = join(userData, 'synced');
    await mkdir(folder);
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.useFolder(folder);
    const broken = '{ not json';
    await writeFile(join(folder, 'settings.json'), broken);

    const reopened = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(reopened.get().ingest.fileNaming).toBe(defaults.ingest.fileNaming);
    expect(reopened.folderInfo().problem).toMatch(/could not be read/);
    expect(reopened.folderInfo().problem).toMatch(/half-synced|conflict/);
    expect(() => reopened.set({ copyMetadataFields: ['headline'] })).toThrowError(
      /could not be read/,
    );
    expect(await readFile(join(folder, 'settings.json'), 'utf8')).toBe(broken);
    expect((await readdir(folder)).some((name) => name.includes('corrupt'))).toBe(false);
  });
});

describe('paths that belong to one computer', () => {
  it("keeps the other computer's references through add, remove and reorder, and removes one on its own computer", async () => {
    const root = await tempDir();
    const userDataA = join(root, 'userdata-a');
    const userDataB = join(root, 'userdata-b');
    const folder = join(root, 'settings');
    await Promise.all([mkdir(userDataA), mkdir(userDataB), mkdir(folder)]);

    const a = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    a.useFolder(folder);
    a.set({ metadataTemplates: ['/machine/a1.XMP', '/machine/a2.XMP'] });
    const aMachine = await readJson(join(userDataA, 'machine.json'));
    const aPaths = aMachine.paths as Record<string, string>;
    const a1 = Object.keys(aPaths).find((id) => aPaths[id] === '/machine/a1.XMP');
    expect(a1).toBeDefined();

    const b = new SettingsStore(join(userDataB, 'settings.json'), defaults);
    b.useFolder(folder);
    expect(b.get().metadataTemplates).toEqual([]);
    b.set({ metadataTemplates: ['/machine/b1.XMP'] });
    b.set({ metadataTemplates: ['/machine/b2.XMP', '/machine/b1.XMP'] });
    expect(b.get().metadataTemplates).toEqual(['/machine/b2.XMP', '/machine/b1.XMP']);

    const shared = await readJson(join(folder, 'settings.json'));
    expect(shared.metadataTemplates).toHaveLength(4);
    const refs = shared.metadataTemplates as Array<Record<string, string>>;
    expect(refs.map((ref) => ref.machine).filter(Boolean)).toEqual(
      expect.arrayContaining([a1, expect.any(String), expect.any(String), expect.any(String)]),
    );

    const aAgain = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    expect(aAgain.get().metadataTemplates).toEqual(['/machine/a1.XMP', '/machine/a2.XMP']);
    aAgain.set({ metadataTemplates: ['/machine/a2.XMP'] });

    const afterRemoval = await readJson(join(folder, 'settings.json'));
    expect(afterRemoval.metadataTemplates).toHaveLength(3);
    const aPathsAfter = (await readJson(join(userDataA, 'machine.json'))).paths as Record<
      string,
      string
    >;
    expect(Object.values(aPathsAfter)).not.toContain('/machine/a1.XMP');
    expect(Object.values(aPathsAfter)).toContain('/machine/a2.XMP');

    const aRestarted = new SettingsStore(join(userDataA, 'settings.json'), defaults);
    expect(aRestarted.get().metadataTemplates).toEqual(['/machine/a2.XMP']);
    const bRestarted = new SettingsStore(join(userDataB, 'settings.json'), defaults);
    expect(bRestarted.get().metadataTemplates).toEqual(['/machine/b2.XMP', '/machine/b1.XMP']);
  });

  it('keeps optional source fields it does not know through a save and restart', async () => {
    const userData = await tempDir();
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    const card = {
      id: asSourceId('card'),
      kind: 'folder',
      name: 'Card',
      path: '/card',
      watchForNewFiles: true,
      futureField: { keep: true },
    } as unknown as SourceConfig;
    const remote = {
      ...ftpSource,
      watchForNewFiles: true,
      futureField: { keep: true },
    } as unknown as SourceConfig;
    store.saveSource(card);
    store.saveSource(remote);

    const reopened = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(reopened.listSources().find((source) => source.id === 'card')).toMatchObject({
      watchForNewFiles: true,
      futureField: { keep: true },
    });
    expect(reopened.listSources().find((source) => source.id === 'pool')).toMatchObject({
      watchForNewFiles: true,
      futureField: { keep: true },
    });
    expect((await readJson(join(userData, 'machine.json'))).sources).toMatchObject([
      { watchForNewFiles: true, futureField: { keep: true } },
    ]);
    expect((await readJson(join(userData, 'settings.json'))).sources).toMatchObject([
      { watchForNewFiles: true, futureField: { keep: true } },
    ]);
  });
});

describe('a missing or unwritable settings folder', () => {
  it('says so at start and never writes defaults over a missing folder', async () => {
    const root = await tempDir();
    const userData = join(root, 'userdata');
    const folder = join(root, 'sync', 'settings');
    await mkdir(userData);
    await mkdir(folder, { recursive: true });
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.useFolder(folder);
    store.set({ copyMetadataFields: ['headline'] });
    const machineBefore = await readFile(join(userData, 'machine.json'), 'utf8');

    await rm(folder, { recursive: true, force: true });

    const missing = new SettingsStore(join(userData, 'settings.json'), defaults);
    const info = missing.folderInfo();
    expect(info.problem).toBeDefined();
    expect(info.problem).toContain(folder);
    expect(info.problem).toContain('not available');
    expect(info.hasSettings).toBe(false);
    expect(() => missing.set({ copyMetadataFields: ['city'] })).toThrowError(/not available/);
    expect(() => missing.saveSource(ftpSource)).toThrowError(/not available/);
    expect(await readdir(join(root, 'sync'))).toEqual([]);
    expect(await readFile(join(userData, 'machine.json'), 'utf8')).toBe(machineBefore);
    expect((await readdir(userData)).sort()).toEqual(['machine.json']);
  });

  it('loads the folder again when it comes back', async () => {
    const root = await tempDir();
    const userData = join(root, 'userdata');
    const folder = join(root, 'sync', 'settings');
    await Promise.all([mkdir(userData), mkdir(folder, { recursive: true })]);
    const first = new SettingsStore(join(userData, 'settings.json'), defaults);
    first.useFolder(folder);
    first.set({ copyMetadataFields: ['headline'] });

    await rename(folder, `${folder}-away`);
    const missing = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(missing.folderInfo().problem).toBeDefined();
    await rename(`${folder}-away`, folder);
    const back = missing.useFolder(folder);
    expect(back.problem).toBeUndefined();
    expect(missing.get().copyMetadataFields).toEqual(['headline']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses to write to a settings folder that is not writable',
    async () => {
      const root = await tempDir();
      const userData = join(root, 'userdata');
      const folder = join(root, 'settings');
      await Promise.all([mkdir(userData), mkdir(folder)]);
      const store = new SettingsStore(join(userData, 'settings.json'), defaults);
      store.useFolder(folder);
      store.set({ copyMetadataFields: ['headline'] });
      const before = await readFile(join(folder, 'settings.json'), 'utf8');

      await chmod(folder, 0o555);
      try {
        const locked = new SettingsStore(join(userData, 'settings.json'), defaults);
        expect(locked.folderInfo().problem).toContain('not writable');
        expect(() => locked.set({ copyMetadataFields: ['city'] })).toThrowError(/not writable/);
        expect(await readFile(join(folder, 'settings.json'), 'utf8')).toBe(before);
      } finally {
        await chmod(folder, 0o755);
      }
    },
  );
});

describe('a password that did not travel with the settings', () => {
  it('keeps the reference and fails as a password problem, never as anonymous FTP', async () => {
    const root = await tempDir();
    const ftpRoot = join(root, 'ftp');
    await mkdir(ftpRoot);
    // This server would accept an anonymous login, so an anonymous retry would succeed.
    const server = await startFtpServer({ root: ftpRoot, anonymous: true });
    const folder = join(root, 'settings');
    const userDataA = join(root, 'userdata-a');
    const userDataB = join(root, 'userdata-b');
    await Promise.all([mkdir(folder), mkdir(userDataA), mkdir(userDataB)]);
    const synced: FtpDestination = {
      ...ftpDestination,
      host: '127.0.0.1',
      port: server.port,
    };
    try {
      const a = new SettingsStore(join(userDataA, 'settings.json'), defaults);
      a.useFolder(folder);
      a.saveDestination(synced);

      const b = new SettingsStore(join(userDataB, 'settings.json'), defaults);
      b.useFolder(folder);
      expect(b.getDestination(ftpDestination.id)).toMatchObject({
        kind: 'ftp',
        credentialRef: 'cred-desk',
      });
      // The shared file keeps the opaque reference, never a password.
      expect(await readFile(join(folder, 'settings.json'), 'utf8')).toContain('cred-desk');
      expect(await readFile(join(folder, 'settings.json'), 'utf8')).not.toContain('password');

      const backend = await createBackend({
        userDataDir: userDataB,
        appVersion: 'test',
        emit: () => {},
        // What main does for a reference this computer has no secret for.
        getSecret: async () => {
          throw new IpcError('not_found', 'no credential stored for "cred-desk"');
        },
      });
      try {
        const handlers = backend.handlers as IpcHandlers;
        const listed = await handlers['destinations:list']();
        expect(listed.find((destination) => destination.id === ftpDestination.id)).toMatchObject({
          kind: 'ftp',
          credentialRef: 'cred-desk',
        });
        const result = await handlers['destinations:test']({ destination: synced });
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/credential|password/i);
      } finally {
        await backend.dispose();
      }
    } finally {
      await server.close();
    }
  });
});

describe('settings folder choice', () => {
  it('copies the current settings and presets into an empty folder, keeping the old files', async () => {
    const root = await tempDir();
    const userData = join(root, 'userdata');
    const folder = join(root, 'settings');
    await Promise.all([
      mkdir(userData),
      mkdir(folder),
      mkdir(join(userData, 'presets'), { recursive: true }),
    ]);
    await writeFile(join(userData, 'presets', `${'a'.repeat(24)}.json`), '{"id":"p"}');
    await writeFile(join(userData, 'presets', 'not-ours.json'), '{}');

    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.set({ copyMetadataFields: ['headline'] });
    expect(store.inspectFolder(folder)).toEqual({ path: folder, hasSettings: false });

    const info = store.copyToFolder(folder);
    expect(info).toMatchObject({ path: folder, isDefault: false, hasSettings: true });
    expect((await readJson(join(folder, 'settings.json'))).copyMetadataFields).toEqual([
      'headline',
    ]);
    expect(await readdir(join(folder, 'presets'))).toEqual([`${'a'.repeat(24)}.json`]);
    // The old files are still there; nothing was moved or deleted.
    expect(await readdir(join(userData, 'presets'))).toEqual(
      expect.arrayContaining(['not-ours.json']),
    );
  });

  it('offers to use a folder that already has settings instead of copying over it', async () => {
    const root = await tempDir();
    const userData = await tempDir();
    const folder = join(root, 'settings');
    await mkdir(folder);
    const otherUserData = join(root, 'other');
    await mkdir(otherUserData);
    const other = new SettingsStore(join(otherUserData, 'settings.json'), defaults);
    other.useFolder(folder);
    other.set({ copyMetadataFields: ['headline'] });

    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(store.inspectFolder(folder)).toMatchObject({ hasSettings: true });
    expect(() => store.copyToFolder(folder)).toThrowError(/already has settings/);
    const info = store.useFolder(folder);
    expect(info.isDefault).toBe(false);
    expect(store.get().copyMetadataFields).toEqual(['headline']);

    const again = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(again.folderInfo().path).toBe(folder);
    expect(again.get().copyMetadataFields).toEqual(['headline']);
  });

  it('never accepts a path of the other path system as this machine', async () => {
    const userData = await tempDir();
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    if (process.platform === 'win32') {
      expect(() => store.useFolder('/home/test/settings')).toThrowError(/absolute path/);
    } else {
      expect(() => store.useFolder('C:\\Users\\test\\settings')).toThrowError(/absolute path/);
    }
  });
});

describe('template paths in the settings folder', () => {
  it('stores a template below the settings folder relative and resolves it again', async () => {
    const userData = await tempDir();
    const folder = join(userData, 'synced');
    await mkdir(folder);
    const template = join(folder, 'templates', 'ingest.XMP');
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.useFolder(folder);
    store.set({
      metadataTemplates: [template, '/machine/local.XMP'],
      codeReplacementPaths: [join(folder, 'codes.txt')],
      ingest: { ...defaults.ingest, metadataTemplatePath: template },
    });

    const shared = await readJson(join(folder, 'settings.json'));
    expect(shared.metadataTemplates).toEqual([
      { folder: 'templates/ingest.XMP' },
      { machine: expect.any(String) },
    ]);
    expect(shared.codeReplacementPaths).toEqual([{ folder: 'codes.txt' }]);
    expect(shared.ingest).toMatchObject({
      metadataTemplate: { folder: 'templates/ingest.XMP' },
    });

    const machine = await readJson(join(userData, 'machine.json'));
    expect(Object.values(machine.paths as Record<string, string>)).toEqual(['/machine/local.XMP']);

    const reopened = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(reopened.get().metadataTemplates).toEqual([template, '/machine/local.XMP']);
    expect(reopened.get().codeReplacementPaths).toEqual([join(folder, 'codes.txt')]);
    expect(reopened.get().ingest.metadataTemplatePath).toBe(template);
  });

  it('does not resolve an absolute path of the other operating system', async () => {
    const userData = await tempDir();
    const folder = join(userData, 'synced');
    await mkdir(folder);
    const store = new SettingsStore(join(userData, 'settings.json'), defaults);
    store.useFolder(folder);
    store.set({ metadataTemplates: ['C:\\Users\\test\\template.XMP'] });
    // Stored as this machine's path, so the other computer does not see it.
    const machine = await readJson(join(userData, 'machine.json'));
    expect(Object.values(machine.paths as Record<string, string>)).toEqual([
      'C:\\Users\\test\\template.XMP',
    ]);
    expect(store.get().metadataTemplates).toEqual(['C:\\Users\\test\\template.XMP']);

    // A shared folder reference is resolved with this platform's rules, never as C:\.
    const sharedFile = join(folder, 'settings.json');
    const shared = await readJson(sharedFile);
    await writeFile(
      sharedFile,
      JSON.stringify({ ...shared, metadataTemplates: [{ folder: 'C:/Users/test/x.XMP' }] }),
    );
    const reopened = new SettingsStore(join(userData, 'settings.json'), defaults);
    expect(reopened.get().metadataTemplates).toEqual([]);
  });
});
