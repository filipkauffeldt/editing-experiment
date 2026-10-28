import { createBridge, type BridgeTransport, type EeBridge } from '@ee/contracts';

declare global {
  interface Window {
    /** Raw IPC transport injected by the preload script. Use {@link ee} instead. */
    eeTransport: BridgeTransport;
  }
}

/**
 * The preload transport is resolved on each call so tests can install an
 * in-memory transport before or after importing a component.
 */
const transport: BridgeTransport = {
  invoke: (channel, args) => window.eeTransport.invoke(channel, args),
  subscribe: (channel, listener) => window.eeTransport.subscribe(channel, listener),
};

/** Typed access to the backend: `ee.invoke('photos:list')`, `ee.on('photos:added', ...)`. */
export const ee: EeBridge = createBridge(transport);
