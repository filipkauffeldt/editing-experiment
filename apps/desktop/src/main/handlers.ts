import { notImplemented, type NamespaceHandlers } from '@ee/contracts';
import { BrowserWindow, dialog } from 'electron';
import { homedir } from 'node:os';
import { defaultSettings } from '../shared/settings';
import type { AppSettings } from '@ee/contracts';

let settings: AppSettings = defaultSettings(homedir());

/**
 * Settings live in memory for now.
 * TODO(wave 2): persist to the user data directory; XMP sidecars stay the source of truth for photos.
 */
export const settingsHandlers: NamespaceHandlers<'settings'> = {
  'settings:get': async () => settings,
  'settings:set': async (patch) => {
    settings = { ...settings, ...patch };
    return settings;
  },
};

export const dialogHandlers: NamespaceHandlers<'dialog'> = {
  'dialog:pick': async ({ kind, title, extensions, multiple }) => {
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
export const credentialsHandlers: NamespaceHandlers<'credentials'> = {
  'credentials:set': notImplemented('credentials:set'),
  'credentials:remove': notImplemented('credentials:remove'),
};
