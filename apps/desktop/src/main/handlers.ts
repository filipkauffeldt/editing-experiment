import { notImplemented, type NamespaceHandlers } from '@ee/contracts';
import { BrowserWindow, dialog } from 'electron';
import { homedir } from 'node:os';
import { mockSettings } from '../shared/mock';
import { defaultSettings } from '../shared/settings';
import type { AppSettings } from '@ee/contracts';

const mock = process.env.EE_MOCK === '1';

let settings: AppSettings = mock ? mockSettings() : defaultSettings(homedir());

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
    // Mock mode never opens a native dialog: screenshots and tests must not
    // block on a window that a human has to dismiss.
    if (mock) {
      const picked = extensions?.includes('xmp')
        ? title?.toLowerCase().includes('template')
          ? '/mock/templates/premier-league.XMP'
          : '/mock/presets/Press Punchy.xmp'
        : extensions?.includes('txt')
          ? '/mock/code-replacements.txt'
          : kind === 'folder'
            ? '/mock/cards/NIKON_Z9'
            : '/mock/picked/file.jpg';
      return multiple ? [picked, '/mock/presets/Daylight Neutral.xmp'] : [picked];
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
    }
  : {
      'credentials:set': notImplemented('credentials:set'),
      'credentials:remove': notImplemented('credentials:remove'),
    };
