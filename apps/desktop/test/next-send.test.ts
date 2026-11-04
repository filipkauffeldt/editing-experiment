import { asPhotoId, asPresetId, type EditParams } from '@ee/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FullResolutionRenderRequest } from '../src/renderer/export-render';
import {
  activePhoto,
  createAppStore,
  selectVisiblePhotos,
  type AppStore,
} from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

type Rendered = { width: number; height: number; rgba: Uint8Array };
const pixel = (): Rendered => ({ width: 1, height: 1, rgba: new Uint8Array(4) });

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

async function setup(
  options: Parameters<typeof createFakeBridge>[0] = {},
  renderForExport: (request: FullResolutionRenderRequest) => Promise<Rendered> = async () =>
    pixel(),
): Promise<{ store: AppStore; fake: FakeBridge }> {
  const fake = createFakeBridge(options);
  const store = createAppStore(fake.bridge, { renderForExport });
  stores.push(store);
  await store.init();
  return { store, fake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const names = (store: AppStore): string[] =>
  selectVisiblePhotos(store.getState()).map((photo) => photo.fileName);
const active = (store: AppStore): string | undefined => activePhoto(store.getState())?.fileName;
const started = (fake: FakeBridge) => fake.calls.filter((call) => call.channel === 'export:start');
const jobs = (store: AppStore) => store.getState().exportJobs;
const errorToasts = (store: AppStore) =>
  store.getState().toasts.filter((toast) => toast.kind === 'error');

describe('Next & send in the background', () => {
  it('moves to the next photo before the export has finished', async () => {
    const gate = deferred<Rendered>();
    const { store, fake } = await setup({}, () => gate.promise);
    const [first, second] = names(store);

    const handedOver = store.nextAndSend();
    // Synchronously: no await between the press and this check.
    expect(active(store)).toBe(second);

    await handedOver;
    await vi.waitFor(() => expect(jobs(store)[0]?.state).toBe('running'));
    expect(started(fake)).toHaveLength(1);
    expect(jobs(store)[0]?.photos[0]?.state).toBe('rendering');
    expect(active(store)).toBe(second);

    gate.resolve(pixel());
    await vi.waitFor(() => expect(jobs(store)[0]?.state).toBe('done'));
    expect(active(store)).toBe(second);
    expect(first).not.toBe(second);
  });

  it('exports three photos pressed in a row, in order, and all of them finish', async () => {
    const renders: string[] = [];
    const gate = deferred<Rendered>();
    const { store, fake } = await setup({}, async (request) => {
      renders.push(request.photo.fileName);
      await gate.promise;
      return pixel();
    });
    const [a, b, c, d] = names(store);

    void store.nextAndSend();
    void store.nextAndSend();
    void store.nextAndSend();
    expect(active(store)).toBe(d);

    gate.resolve(pixel());
    await vi.waitFor(() => {
      expect(jobs(store)).toHaveLength(3);
      expect(jobs(store).every((job) => job.state === 'done')).toBe(true);
    });
    expect(renders).toEqual([a, b, c]);
    expect(started(fake).map((call) => (call.args[0] as { photoIds: string[] }).photoIds)).toEqual(
      selectVisiblePhotos(store.getState())
        .slice(0, 3)
        .map((photo) => [photo.id]),
    );
    expect(errorToasts(store)).toEqual([]);
  });

  it('keeps going from the photo that is on screen when the press is a moment late', async () => {
    const { store } = await setup();
    const order = names(store);
    store.selectRelative(3);
    void store.nextAndSend();
    expect(active(store)).toBe(order[4]);
  });

  it('exports the last photo once for a double press, and again once the render is taken', async () => {
    const gate = deferred<Rendered>();
    const { store, fake } = await setup({}, () => gate.promise);
    store.selectRelative(1000);
    const last = names(store).at(-1);
    expect(active(store)).toBe(last);

    const first = store.nextAndSend();
    const second = store.nextAndSend();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(jobs(store)[0]?.photos[0]?.state).toBe('rendering'));
    // Still in the render: the export was started, so this is still a double press.
    await store.nextAndSend();

    expect(active(store)).toBe(last);
    expect(started(fake)).toHaveLength(1);

    gate.resolve(pixel());
    await vi.waitFor(() => expect(jobs(store)[0]?.state).toBe('done'));
    await store.nextAndSend();
    expect(started(fake)).toHaveLength(2);
  });

  it('skips photos a filter hides, using the order at the time of the press', async () => {
    const { store } = await setup();
    store.setQuickFilter('tagged');
    const tagged = names(store);
    expect(tagged.length).toBeGreaterThan(2);
    expect(active(store)).toBe(tagged[0]);

    void store.nextAndSend();
    expect(active(store)).toBe(tagged[1]);
    void store.nextAndSend();
    expect(active(store)).toBe(tagged[2]);
  });

  it('exports what was on screen when pressed, even while the save is slow', async () => {
    const renders: { fileName: string; params: EditParams }[] = [];
    const slowSave = deferred();
    const { store, fake } = await setup(
      {
        handlers: {
          'develop:setParams': async () => {
            await slowSave.promise;
          },
        },
      },
      async (request) => {
        renders.push({ fileName: request.photo.fileName, params: request.params });
        return pixel();
      },
    );
    const [first, second] = names(store);
    const firstId = activePhoto(store.getState())!.id;
    await vi.waitFor(() => expect(store.getState().metadata[firstId]).toBeDefined());

    store.setSlider('Exposure2012', 0.75);
    store.updateMetadataField(firstId, 'headline', 'Edited just before the press');
    void store.nextAndSend();
    // The press did not wait for the save…
    expect(active(store)).toBe(second);
    // …and an edit on the new photo is not part of the first photo's export.
    store.setSlider('Exposure2012', -1);
    await vi.waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'develop:setParams')).toBe(true),
    );
    expect(started(fake)).toHaveLength(0);

    slowSave.resolve();
    await vi.waitFor(() => expect(jobs(store)[0]?.state).toBe('done'));

    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ fileName: first, params: { Exposure2012: 0.75 } });
    const channels = fake.calls.map((call) => call.channel);
    const metadataWrite = fake.calls.find(
      (call) =>
        call.channel === 'metadata:write' &&
        (call.args[0] as { photoId: string }).photoId === firstId,
    );
    expect(metadataWrite?.args[0]).toMatchObject({
      fields: { headline: 'Edited just before the press' },
    });
    expect(channels.indexOf('metadata:write')).toBeLessThan(channels.indexOf('export:start'));
    expect(channels.indexOf('develop:setParams')).toBeLessThan(channels.indexOf('export:start'));
  });

  it('renders a photo whose settings were never read from the store', async () => {
    const renders: FullResolutionRenderRequest[] = [];
    const saved: EditParams = { Exposure2012: 1.25 };
    const hold = deferred();
    const { store } = await setup(
      {
        handlers: {
          'develop:getParams': async (...args) => {
            const { photoId } = args[0] as { photoId: string };
            // The second photo's settings are slow to arrive.
            if (photoId === 'mock-02') await hold.promise;
            return photoId === 'mock-02' ? saved : {};
          },
        },
      },
      async (request) => {
        renders.push(request);
        return pixel();
      },
    );
    store.select(asPhotoId('mock-02'));
    void store.nextAndSend();
    hold.resolve();
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    expect(renders[0]?.params).toMatchObject(saved);
  });

  it('toasts a failure by file name without pulling the user back', async () => {
    const { store } = await setup({}, async (request) => {
      if (request.photo.fileName === '_DSC8330.NEF') throw new Error('disk full');
      return pixel();
    });
    const [first, second, third] = names(store);

    void store.nextAndSend();
    void store.nextAndSend();
    await vi.waitFor(() => expect(jobs(store).every((job) => job.state !== 'running')).toBe(true));
    await vi.waitFor(() => expect(errorToasts(store)).toHaveLength(1));

    expect(errorToasts(store)[0]?.message).toBe(`Could not export ${first}: disk full`);
    expect(active(store)).toBe(third);
    expect(jobs(store).filter((job) => job.state === 'done')).toHaveLength(1);
    expect(second).toBeDefined();
  });

  it('toasts when the export cannot be handed over', async () => {
    const { store } = await setup({
      handlers: {
        'export:start': async () => {
          throw new Error('the export queue is closed');
        },
      },
    });
    const [first, second] = names(store);
    await store.nextAndSend();
    expect(active(store)).toBe(second);
    expect(errorToasts(store).map((toast) => toast.message)).toEqual([
      `Could not export ${first}: the export queue is closed`,
    ]);
    // The photo is free to be sent again.
    await store.nextAndSend();
    expect(errorToasts(store)).toHaveLength(2);
  });

  it('stays on the photo and says why when the export cannot start', async () => {
    const { store, fake } = await setup();
    for (const preset of [...store.getState().exportPresets]) {
      await store.removeExportPreset(preset.id);
    }
    const before = active(store);

    await store.nextAndSend();

    expect(active(store)).toBe(before);
    expect(started(fake)).toHaveLength(0);
    expect(errorToasts(store).map((toast) => toast.message)).toEqual([
      'No export preset is configured',
    ]);
    // Nothing is left waiting: with a preset again, the same photo goes.
    await store.saveExportPreset({
      ...fake.settings.exportPresets[0]!,
      id: asPresetId('again'),
    });
    await store.nextAndSend();
    expect(started(fake)).toHaveLength(1);
  });

  it('does not stop the next press after a failed one', async () => {
    const { store } = await setup({}, async (request) => {
      if (request.photo.fileName === '_DSC8330.NEF') throw new Error('nope');
      return pixel();
    });
    void store.nextAndSend();
    void store.nextAndSend();
    await vi.waitFor(() => expect(jobs(store)).toHaveLength(2));
    await vi.waitFor(() =>
      expect(
        jobs(store)
          .map((job) => job.state)
          .sort(),
      ).toEqual(['done', 'failed']),
    );
  });
});
