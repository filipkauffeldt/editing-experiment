import {
  DEFAULT_COPY_SETTING_GROUPS,
  applyDevelopSettingGroups,
  type EditParams,
  type Photo,
} from '@ee/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeDevelopVersion,
  activePhoto,
  createAppStore,
  editParamsKey,
  type AppStore,
} from '../src/renderer/store';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function setup(
  options: Parameters<typeof createFakeBridge>[0] = {},
): Promise<{ store: AppStore; fake: FakeBridge; photo: Photo }> {
  const fake = createFakeBridge(options);
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  await store.init();
  const photo = activePhoto(store.getState());
  if (!photo) throw new Error('no selection');
  await vi.waitFor(() =>
    expect(
      store.getState().editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)],
    ).toBeDefined(),
  );
  return { store, fake, photo };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const params = (store: AppStore, photo: Photo): EditParams =>
  store.getState().editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)] ?? {};

const setParamsWrites = (fake: FakeBridge, from = 0): EditParams[] =>
  fake.calls
    .slice(from)
    .filter((call) => call.channel === 'develop:setParams')
    .map((call) => (call.args[0] as { params: EditParams }).params);

/** A backend that applies parameter writes one at a time, like the sidecar writer. */
function serializedWrites(): {
  writes: EditParams[];
  applied(): EditParams | undefined;
  handler: (...args: unknown[]) => Promise<void>;
} {
  const writes: EditParams[] = [];
  let applied: EditParams | undefined;
  let chain: Promise<void> = Promise.resolve();
  const handler = async (...args: unknown[]): Promise<void> => {
    const { params } = args[0] as { params: EditParams };
    writes.push(params);
    const run = chain.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      applied = params;
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  };
  return { writes, applied: () => applied, handler };
}

describe('develop undo against the debounced save', () => {
  it('writes the undone state after a pending change, never the newer state', async () => {
    const sidecar = serializedWrites();
    const { store, photo } = await setup({
      handlers: { 'develop:setParams': sidecar.handler },
    });

    store.setSlider('Exposure2012', 0.1);
    // The first write is in flight, this one waits for the throttle.
    store.setSlider('Exposure2012', 0.2);
    expect(store.undoDevelop()).toBe(true);

    await vi.waitFor(() => expect(sidecar.applied()).toEqual({ Exposure2012: 0.1 }));
    expect(sidecar.writes).toEqual([{ Exposure2012: 0.1 }, { Exposure2012: 0.1 }]);
    expect(params(store, photo)).toEqual({ Exposure2012: 0.1 });
  });

  it('writes the redone state after an undo inside the throttle window', async () => {
    const sidecar = serializedWrites();
    const { store, photo } = await setup({
      handlers: { 'develop:setParams': sidecar.handler },
    });

    store.setSlider('Exposure2012', 0.1);
    store.setSlider('Exposure2012', 0.2);
    expect(store.undoDevelop()).toBe(true);
    expect(store.redoDevelop()).toBe(true);

    await vi.waitFor(() => expect(sidecar.applied()).toEqual({ Exposure2012: 0.2 }));
    expect(sidecar.writes).toEqual([
      { Exposure2012: 0.1 },
      { Exposure2012: 0.1 },
      { Exposure2012: 0.2 },
    ]);
    expect(params(store, photo)).toEqual({ Exposure2012: 0.2 });
  });

  it('undoes a batch paste only after its backend write has settled', async () => {
    const photos = mockPhotos();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedApply = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fake = createFakeBridge({
      photos,
      handlers: {
        'develop:applySettings': async (...args: unknown[]) => {
          started();
          await gate;
          const {
            photoIds,
            params: source,
            groups,
          } = args[0] as {
            photoIds: Photo['id'][];
            params: EditParams;
            groups: (typeof DEFAULT_COPY_SETTING_GROUPS)[number][];
          };
          return photoIds.map((photoId) => {
            const photo = photos.find((candidate) => candidate.id === photoId);
            if (!photo) throw new Error(`no photo ${photoId}`);
            const develop = photo.versions.find((version) => version.kind === 'develop');
            const next = applyDevelopSettingGroups(
              develop?.kind === 'develop' ? develop.ops : {},
              source,
              groups,
            );
            if (develop?.kind === 'develop') develop.ops = next;
            return photo;
          });
        },
      },
    });
    const store = createAppStore(fake.bridge, {
      renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    });
    stores.push(store);
    await store.init();
    const source = activePhoto(store.getState());
    const target = store.getState().photos.find((candidate) => candidate.id !== source?.id);
    if (!source || !target) throw new Error('no photos');

    store.setSlider('Exposure2012', 0.5);
    await vi.waitFor(() => expect(setParamsWrites(fake).at(-1)).toEqual({ Exposure2012: 0.5 }));
    store.openCopySettings('copy');
    store.confirmCopySettings(DEFAULT_COPY_SETTING_GROUPS);
    store.select(target.id);
    store.pasteSettings();
    await startedApply;

    const from = fake.calls.length;
    // The paste step is not in the history yet, so this must wait for it.
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, target)).toEqual({});
    release();
    await vi.waitFor(() => expect(params(store, target)).toEqual({}));
    await vi.waitFor(() => expect(setParamsWrites(fake, from)).toEqual([{}]));
    expect(params(store, source)).toEqual({ Exposure2012: 0.5 });
  });
});

describe('develop history and settings loaded from outside', () => {
  it('keeps the history when the sidecar still holds what the history expects', async () => {
    const { store, fake, photo } = await setup();
    const second = store.getState().photos.find((candidate) => candidate.id !== photo.id);
    if (!second) throw new Error('no second photo');

    store.setSlider('Exposure2012', 0.5);
    await vi.waitFor(() => expect(setParamsWrites(fake).at(-1)).toEqual({ Exposure2012: 0.5 }));
    store.undoDevelop();
    await vi.waitFor(() => expect(setParamsWrites(fake).at(-1)).toEqual({}));

    const key = editParamsKey(photo.id, activeDevelopVersion(photo)?.id);
    const reads = fake.calls.filter((call) => call.channel === 'develop:getParams').length;
    store.select(second.id);
    store.select(photo.id);
    await vi.waitFor(() =>
      expect(
        fake.calls.filter((call) => call.channel === 'develop:getParams').length,
      ).toBeGreaterThan(reads),
    );
    expect(store.getState().editParams[key]).toEqual({});
    expect(store.canRedoDevelop(photo.id)).toBe(true);
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({ Exposure2012: 0.5 });
  });

  it('does not take a sidecar read that is behind a pending write for an outside change', async () => {
    const sidecar = serializedWrites();
    const { store, photo } = await setup({
      handlers: { 'develop:setParams': sidecar.handler },
    });
    const second = store.getState().photos.find((candidate) => candidate.id !== photo.id);
    if (!second) throw new Error('no second photo');

    store.setSlider('Exposure2012', 0.5);
    // The write is still in flight, so the read of the sidecar is the old {}.
    store.select(second.id);
    store.select(photo.id);
    await vi.waitFor(() => expect(sidecar.applied()).toEqual({ Exposure2012: 0.5 }));
    expect(params(store, photo)).toEqual({ Exposure2012: 0.5 });
    expect(store.canUndoDevelop(photo.id)).toBe(true);
    expect(store.undoDevelop()).toBe(true);
    await vi.waitFor(() => expect(sidecar.applied()).toEqual({}));
  });

  it('clears the history when the sidecar was changed outside it', async () => {
    const { store, fake, photo } = await setup();
    const second = store.getState().photos.find((candidate) => candidate.id !== photo.id);
    if (!second) throw new Error('no second photo');

    store.setSlider('Exposure2012', 0.5);
    await vi.waitFor(() => expect(setParamsWrites(fake).at(-1)).toEqual({ Exposure2012: 0.5 }));
    const versionId = activeDevelopVersion(photo)?.id;
    // Another program writes the sidecar while the photo is not open in Develop.
    await fake.bridge.invoke('develop:setParams', {
      photoId: photo.id,
      versionId,
      params: { Exposure2012: 1.5 },
    });

    store.select(second.id);
    store.select(photo.id);
    await vi.waitFor(() => expect(params(store, photo)).toEqual({ Exposure2012: 1.5 }));
    expect(store.canUndoDevelop(photo.id)).toBe(false);
    expect(store.undoDevelop()).toBe(false);
    expect(params(store, photo)).toEqual({ Exposure2012: 1.5 });
  });
});
