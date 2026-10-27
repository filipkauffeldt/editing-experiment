import { createBridge, type BridgeTransport, type EeBridge } from '@ee/contracts';

declare global {
  interface Window {
    /** Raw IPC transport injected by the preload script. Use {@link ee} instead. */
    eeTransport: BridgeTransport;
  }
}

/** Typed access to the backend: `ee.invoke('photos:list')`, `ee.on('photos:added', ...)`. */
export const ee: EeBridge = createBridge(window.eeTransport);
