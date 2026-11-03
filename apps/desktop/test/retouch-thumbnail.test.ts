// @vitest-environment node
import {
  appUrl,
  asSourceId,
  createBridge,
  toIpcResult,
  type BridgeTransport,
  type EventChannel,
  type IpcHandlers,
  type MosaicOp,
  type Photo,
  type RenderedImage,
} from '@ee/contracts';
import { decodeJpeg, encodeJpeg } from '@ee/core';
import { applyMosaic } from '@ee/retouch';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { createAppStore, type AppStore } from '../src/renderer/store';

const WIDTH = 320;
const HEIGHT = 214;

/** High-frequency, deterministic noise: no 8x8 block of it looks like a mosaic block. */
function noise(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  let seed = 12345;
  for (let i = 0; i < rgba.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      rgba[i + channel] = 40 + (seed >>> 24) * 0.6;
    }
    rgba[i + 3] = 255;
  }
  return rgba;
}

/**
 * What the develop pipeline would draw: the photo's pixels with the retouch version's
 * mosaic on top. The pixels are real; only the WebGL part is left out, which needs a
 * GPU the unit tests do not have.
 */
function drawEdited(ops: readonly { type: string }[], width: number, height: number) {
  let rgba = noise(width, height);
  for (const op of ops) {
    if (op.type === 'mosaic') rgba = applyMosaic(rgba, width, height, op as MosaicOp);
  }
  return { width, height, rgba } satisfies RenderedImage;
}

/** Mean absolute difference between horizontal neighbours inside a pixel region. */
function roughness(
  image: { width: number; rgba: Uint8Array | Buffer },
  region: { x0: number; y0: number; x1: number; y1: number },
): number {
  let total = 0;
  let count = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1 - 1; x++) {
      const at = (y * image.width + x) * 4 + 1;
      total += Math.abs(image.rgba[at]! - image.rgba[at + 4]!);
      count++;
    }
  }
  return total / count;
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the film strip thumbnail of a retouched photo', () => {
  let root: string;
  let backend: Backend;
  let handlers: IpcHandlers;
  let store: AppStore;
  let photo: Photo;
  const listeners = new Map<EventChannel, Set<(payload: unknown) => void>>();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-retouch-thumb-'));
    const card = join(root, 'card');
    await mkdir(card);
    await writeFile(
      join(card, 'shot.jpg'),
      await encodeJpeg(noise(WIDTH, HEIGHT), WIDTH, HEIGHT, {
        quality: 92,
        chroma: '444',
        iccSrgb: true,
      }),
    );
    const added: Photo[] = [];
    backend = await createBackend({
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
    handlers = backend.handlers as IpcHandlers;
    await handlers['ingest:start']({
      config: {
        sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: card }],
        destination: { path: join(root, 'ingest') },
        renameTemplate: '{sourceName}_{seq:3}',
      },
    });
    photo = await waitFor('the photo to be ingested', async () => added[0]);

    // The renderer's real store over the real backend, through the bridge it uses.
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
    store = createAppStore(createBridge(transport), {
      renderEditedPreview: async (_photo, _params, ops) => ({
        thumb: drawEdited(ops, 96, 64),
        preview: drawEdited(ops, WIDTH, HEIGHT),
      }),
    });
  }, 60_000);

  afterAll(async () => {
    await store?.dispose();
    await handlers?.['ingest:stop']?.();
    await backend?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('turns into the mosaicked render after a retouch commit', async () => {
    // React StrictMode (`pnpm dev`) mounts the app, disposes its store and mounts it again.
    await store.init();
    await store.dispose();
    await store.init();
    store.select(photo.id);

    const shape = { type: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 } as const;
    store.toggleRetouch();
    store.addRetouchShape(shape);
    expect(await store.commitRetouch()).toBeDefined();

    const drawn = await waitFor('the mosaicked thumbnail to be stored', async () => {
      const current = await handlers['photos:get']({ photoId: photo.id });
      return current.previewStale === false && (current.previewRevision ?? 0) > 0
        ? current
        : undefined;
    });

    // What the <img> gets for the URL the film strip uses.
    const response = await backend.resolveAppRequest(appUrl.thumb(photo.id, drawn.previewRevision));
    expect(response.status).toBe(200);
    const thumb = await decodeJpeg(await readFile(response.file!));
    expect([thumb.width, thumb.height]).toEqual([96, 64]);

    // The shape covers the middle half of the frame; the top strip is untouched.
    const inside = (image: { width: number; height: number }) => ({
      x0: Math.round(image.width * 0.3),
      y0: Math.round(image.height * 0.3),
      x1: Math.round(image.width * 0.7),
      y1: Math.round(image.height * 0.7),
    });
    const strip = (image: { width: number; height: number }) => ({
      x0: 0,
      y0: 0,
      x1: image.width,
      y1: Math.round(image.height * 0.15),
    });
    // The mosaic flattens the shape, where the photo is noise everywhere else.
    expect(roughness(thumb, inside(thumb))).toBeLessThan(8);
    expect(roughness(thumb, strip(thumb))).toBeGreaterThan(20);

    // The camera thumbnail, which the film strip must never show for this photo, is noise
    // inside the shape too.
    const camera = await decodeJpeg(
      await readFile(join(backend.layout.thumbDir, `${photo.id}.jpg`)),
    );
    expect(roughness(camera, inside(camera))).toBeGreaterThan(20);
  }, 60_000);
});
