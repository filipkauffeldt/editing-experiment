import {
  INVOKE_CHANNELS,
  notImplemented,
  toIpcResult,
  type EventChannel,
  type InvokeChannel,
  type IpcHandlers,
} from '@ee/contracts';
import { BrowserWindow, MessageChannelMain, app, ipcMain, safeStorage } from 'electron';
import { join } from 'node:path';
import { credentialsHandlers, dialogHandlers, settingsHandlers } from './handlers';
import { CredentialStore, credentialHandlers } from './credentials';
import { JobsClient } from './jobs-client';
import { handleAppProtocol, registerAppScheme } from './protocol';
import { hostFor } from '../shared/routing';
import { electronSecretPort, serveSecrets } from '../shared/secret-port';
import { createMainWindow } from './window';

const mock = process.env.EE_MOCK === '1';

// Tests and screenshots run against a throwaway profile. Must be set before `ready`.
if (process.env.EE_USER_DATA_DIR) app.setPath('userData', process.env.EE_USER_DATA_DIR);

registerAppScheme();

function broadcast(channel: EventChannel, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

void app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');
  const startupWarnings: string[] = [];

  /** Handlers served in this process. Everything else is forwarded to the jobs process. */
  const mainHandlers: Partial<IpcHandlers> = { ...settingsHandlers, ...dialogHandlers };
  let credentials: CredentialStore | undefined;
  if (mock) {
    Object.assign(mainHandlers, credentialsHandlers);
  } else {
    // Secrets live encrypted in main and reach the jobs process only through a
    // private port, on request; the renderer can set and remove but never read.
    credentials = new CredentialStore(join(userDataDir, 'credentials.json'), safeStorage, (m) => {
      console.warn(m);
      startupWarnings.push(m);
    });
    Object.assign(mainHandlers, credentialHandlers(credentials));
  }

  const jobs = new JobsClient(broadcast, {
    mock,
    appVersion: app.getVersion(),
    userDataDir,
    // A restarted jobs process needs a fresh port: the old one died with it.
    onStart: (client) => {
      if (!credentials) return;
      const store = credentials;
      const { port1, port2 } = new MessageChannelMain();
      serveSecrets(electronSecretPort(port1), async (ref) => store.get(ref));
      client.sendSecretPort(port2);
    },
  });

  handleAppProtocol({
    mock,
    resolveInJobs: (url) => jobs.resolveApp(url),
    cacheDir: join(userDataDir, 'cache'),
  });

  const dispatch = (channel: InvokeChannel, args: unknown[]): Promise<unknown> => {
    if (hostFor(channel, { mock }) === 'jobs') return jobs.invoke(channel, args);
    const handler = (mainHandlers[channel] ?? notImplemented(channel)) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    return handler(...args);
  };

  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (_event, args: unknown[]) =>
      toIpcResult(() => dispatch(channel, args ?? [])),
    );
  }

  // Let the jobs process close ExifTool, the upload queue and the databases
  // before the app goes away; `quit()` below re-enters with `quitting` set.
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void jobs.shutdown(8_000).finally(() => app.quit());
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  const window = createMainWindow();
  // Problems found before the renderer existed are shown once it has loaded.
  window.webContents.once('did-finish-load', () => {
    for (const message of startupWarnings.splice(0)) {
      broadcast('jobs:event', { type: 'job.error', at: Date.now(), scope: 'startup', message });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
