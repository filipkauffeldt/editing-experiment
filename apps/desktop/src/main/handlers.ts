import {
  notImplemented,
  type AppSettings,
  type NamespaceHandlers,
  type SettingsFolderInfo,
} from '@ee/contracts';
import { BrowserWindow, dialog } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mockSettings } from '../shared/mock';
import { defaultSettings } from '../shared/settings';

const mock = process.env.EE_MOCK === '1';

let settings: AppSettings = mock ? mockSettings() : defaultSettings(homedir());

const mockDefaultFolder = '/home/alex/.config/editing-experiment';
let mockFolder = { path: mockDefaultFolder, hasSettings: true };

const mockFolderInfo = (): SettingsFolderInfo => ({
  path: mockFolder.path,
  defaultPath: mockDefaultFolder,
  isDefault: mockFolder.path === mockDefaultFolder,
  hasSettings: mockFolder.hasSettings,
});

/**
 * Mock mode keeps settings in memory here; the real backend persists them in the
 * jobs process (see `jobs/backend/settings-store.ts`). XMP sidecars stay the source
 * of truth for photos.
 */
export const settingsHandlers: NamespaceHandlers<'settings'> = {
  'settings:get': async () => settings,
  'settings:set': async (patch) => {
    settings = { ...settings, ...patch };
    return settings;
  },
  'settings:folder': async () => mockFolderInfo(),
  'settings:inspectFolder': async ({ path }) => ({
    path,
    hasSettings: mockFolder.path === path && mockFolder.hasSettings,
  }),
  'settings:useFolder': async ({ path }) => {
    mockFolder = { path, hasSettings: true };
    return mockFolderInfo();
  },
  'settings:copyToFolder': async ({ path }) => {
    mockFolder = { path, hasSettings: true };
    return mockFolderInfo();
  },
};

export const dialogHandlers: NamespaceHandlers<'dialog'> = {
  'dialog:pick': async ({ kind, title, extensions, multiple }) => {
    // Mock mode never opens a native dialog: screenshots and tests must not
    // block on a window that a human has to dismiss.
    if (mock) {
      const picked = extensions?.includes('xmp')
        ? title?.toLowerCase().includes('template')
          ? '/mock/templates/premier-league.XMP'
          : '/mock/presets/Press Punchy.xmp'
        : extensions?.includes('txt')
          ? '/mock/code-replacements.txt'
          : kind === 'folder' && title?.toLowerCase().includes('settings folder')
            ? join(homedir(), 'Documents', 'editing-experiment-settings')
            : kind === 'folder'
              ? '/mock/cards/NIKON_Z9'
              : '/mock/picked/file.jpg';
      return multiple ? [picked, '/mock/presets/Daylight Neutral.xmp'] : [picked];
    }
    // End-to-end tests cannot drive a native dialog. `EE_PICK_FOLDER` answers a folder pick for
    // them; the app never sets it.
    if (kind === 'folder' && process.env.EE_PICK_FOLDER) {
      return [process.env.EE_PICK_FOLDER];
    }
    const options: Electron.OpenDialogOptions = {
      title,
      properties: [
        kind === 'folder' ? 'openDirectory' : 'openFile',
        ...(multiple ? (['multiSelections'] as const) : []),
      ],
      filters: extensions ? [{ name: 'Files', extensions }] : undefined,
    };
    const window = BrowserWindow.getFocusedWindow();
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  },
};

/**
 * Secrets are stored with Electron `safeStorage`, which only exists in main, while
 * the jobs process is the one that connects to servers. Open design point: main
 * has to hand a secret to jobs per connection (never to the renderer, never logged).
 */
let mockCredentialCounter = 0;

export const credentialsHandlers: NamespaceHandlers<'credentials'> = mock
  ? {
      // Mock mode never stores the secret; it only mints a reference so the
      // rest of the settings flow (which is real) can be exercised.
      'credentials:set': async ({ ref }) => ({
        ref: ref || `mock-credential-${++mockCredentialCounter}`,
      }),
      'credentials:remove': async () => {},
      'credentials:present': async ({ refs }) => refs,
    }
  : {
      'credentials:set': notImplemented('credentials:set'),
      'credentials:remove': notImplemented('credentials:remove'),
      'credentials:present': notImplemented('credentials:present'),
    };
