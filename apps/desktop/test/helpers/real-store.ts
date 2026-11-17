import {
  asSourceId,
  createBridge,
  toIpcResult,
  type BridgeTransport,
  type EventChannel,
  type IpcHandlers,
  type Photo,
} from '@ee/contracts';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createBackend, type Backend } from '../../src/jobs/backend/backend';
import { createAppStore, type AppStore } from '../../src/renderer/store';

export interface RealStore {
  root: string;
  backend: Backend;
  handlers: IpcHandlers;
  store: AppStore;
  /** The ingested photos in file name order. */
  photos: Photo[];
  dispose(): Promise<void>;
}

export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The renderer's real store over the real backend (index, ExifTool, sidecars on disk), with
 * `count` small JPEGs ingested from a card folder. Undo has to put values back through the same
 * persistence path, so these tests read the files and the index, not a mock.
 */
export async function startRealStore(count: number): Promise<RealStore> {
  const root = await mkdtemp(join(tmpdir(), 'ee-undo-'));
  const card = join(root, 'card');
  await mkdir(card);
  for (let index = 0; index < count; index++) {
    await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#468' },
    })
      .jpeg()
      .toFile(join(card, `game_${index + 1}.jpg`));
  }
  const listeners = new Map<EventChannel, Set<(payload: unknown) => void>>();
  const added: Photo[] = [];
  const backend = await createBackend({
    userDataDir: join(root, 'userData'),
    appVersion: 'test',
    homeDir: root,
    emit: (channel, payload) => {
      if (channel === 'photos:added') added.push(payload as Photo);
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
    getSecret: async () => {
      throw new Error('no secrets in this test');
    },
  });
  const handlers = backend.handlers as IpcHandlers;
  await handlers['ingest:start']({
    config: {
      sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: card }],
      destination: { path: join(root, 'ingest') },
      fileNaming: 'keep',
      renameTemplate: '{filenamebase}',
    },
  });
  await waitFor('the photos to be ingested', () => added.length >= count);

  const transport: BridgeTransport = {
    invoke: (channel, args) =>
      toIpcResult(async () => {
        const handler = handlers[channel] as ((...a: unknown[]) => Promise<unknown>) | undefined;
        if (!handler) throw new Error(`no handler for ${channel}`);
        return handler(...args);
      }),
    subscribe: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      listeners.set(channel, set);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  const store = createAppStore(createBridge(transport));
  await store.init();
  const photos = [...added].sort((a, b) => a.fileName.localeCompare(b.fileName));
  return {
    root,
    backend,
    handlers,
    store,
    photos,
    dispose: async () => {
      await store.dispose();
      await handlers['ingest:stop']?.();
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
