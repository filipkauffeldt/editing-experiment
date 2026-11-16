import type { BridgeTransport, EventChannel, InvokeChannel } from '@ee/contracts';
import { contextBridge, ipcRenderer } from 'electron';

/**
 * Only the raw transport crosses the context bridge. The typed `EeBridge` (and
 * `IpcError`) are built in the renderer with `createBridge`, because
 * `contextBridge` copies thrown errors and would drop `IpcError.code`.
 */
const transport: BridgeTransport = {
  invoke: (channel: InvokeChannel, args: unknown[]) => ipcRenderer.invoke(channel, args),
  subscribe: (channel: EventChannel, listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

contextBridge.exposeInMainWorld('eeTransport', transport);

contextBridge.exposeInMainWorld('eeEnvironment', {
  screenshots: process.argv.includes('--ee-screenshots'),
  // Test only: an index with more photos than this uses the lazy Library paths.
  ...(process.env.EE_LAZY_LIBRARY_PHOTOS === undefined
    ? {}
    : { lazyLibraryPhotos: Number(process.env.EE_LAZY_LIBRARY_PHOTOS) }),
});
