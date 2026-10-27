import type { IpcNamespace } from '@ee/contracts';

/** Which process serves a channel. */
export type ChannelHost = 'main' | 'jobs';

/**
 * Routing is per namespace so a new channel needs no change here as long as it
 * fits an existing namespace. The record type forces a decision for every new
 * namespace.
 *
 * Main serves what needs Electron APIs (dialogs, `safeStorage`, window state);
 * everything else runs in the jobs utility process so the main process stays thin.
 */
export const NAMESPACE_HOST: Record<IpcNamespace, ChannelHost> = {
  system: 'jobs',
  photos: 'jobs',
  ingest: 'jobs',
  sources: 'jobs',
  destinations: 'jobs',
  credentials: 'main',
  metadata: 'jobs',
  develop: 'jobs',
  retouch: 'jobs',
  export: 'jobs',
  upload: 'jobs',
  settings: 'main',
  dialog: 'main',
};
