import {
  INVOKE_CHANNELS,
  channelNamespace,
  notImplemented,
  toIpcResult,
  type EventChannel,
  type InvokeChannel,
  type IpcHandlers,
} from '@ee/contracts';
import { BrowserWindow, app, ipcMain } from 'electron';
import { credentialsHandlers, dialogHandlers, settingsHandlers } from './handlers';
import { JobsClient } from './jobs-client';
import { handleAppProtocol, registerAppScheme } from './protocol';
import { NAMESPACE_HOST } from '../shared/routing';
import { createMainWindow } from './window';

const mock = process.env.EE_MOCK === '1';

registerAppScheme();

/** Handlers served in this process. Everything else is forwarded to the jobs process. */
const mainHandlers: Partial<IpcHandlers> = {
  ...settingsHandlers,
  ...dialogHandlers,
  ...credentialsHandlers,
};

function broadcast(channel: EventChannel, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

void app.whenReady().then(() => {
  handleAppProtocol({ mock });
  const jobs = new JobsClient(broadcast, { mock, appVersion: app.getVersion() });

  const dispatch = (channel: InvokeChannel, args: unknown[]): Promise<unknown> => {
    if (NAMESPACE_HOST[channelNamespace(channel)] === 'jobs') return jobs.invoke(channel, args);
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

  app.on('before-quit', () => jobs.stop());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
