import { describe, expect, it } from 'vitest';
import type { Photo, PhotoId } from '@ee/contracts';
import { createAppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

function photo(index: number, folder: string): Photo {
  const path = `/photos/${folder}/_DSC${String(index).padStart(5, '0')}.NEF`;
  return {
    id: `photo-${index}` as PhotoId,
    path,
    sidecarPath: path.replace(/\.NEF$/, '.xmp'),
    fileName: path.slice(path.lastIndexOf('/') + 1),
    captureTime: new Date(Date.UTC(2026, 4, 1, 12, 0, 0) + index * 1_000).toISOString(),
    sourceId: 'in-place' as Photo['sourceId'],
    tagged: index % 3 === 0,
    colorClass: 0,
    rating: index % 5 === 0 ? 4 : 0,
    status: {
      ingest: 'done',
      edited: false,
      metadataDiffersFromTemplate: false,
      export: 'none',
      upload: 'none',
    },
    versions: [],
  };
}

const photos = [
  ...Array.from({ length: 2_500 }, (_, index) => photo(index, 'match-a')),
  ...Array.from({ length: 100 }, (_, index) => photo(2_500 + index, 'match-b')),
];
const expectedOrder = photos
  .filter((entry) => entry.path.includes('/match-a/'))
  .map((entry) => entry.id);

const world = () => {
  const fake = createFakeBridge({ photos: photos.map((entry) => structuredClone(entry)) });
  const store = createAppStore(fake.bridge, { lazyLibraryPhotos: 0 });
  return { fake, store };
};

describe('lazy Develop', () => {
  it('starts on the newest page and opens the Library folder of the selected photo', async () => {
    const { store } = world();
    try {
      await store.init();
      let state = store.getState();
      expect(state.lazy).toBe(true);
      expect(state.photos).toHaveLength(1_000);
      expect(state.developWindow).toEqual({ offset: 1_600, total: 2_600 });
      expect(state.selectedId).toBe(photos[2_599]!.id);
      expect(state.photos.some((entry) => entry.id === state.selectedId)).toBe(true);

      store.setModule('library');
      await expect.poll(() => store.getState().photos.length).toBe(2_500);
      store.setLibraryFolder('/photos/match-a');
      await expect.poll(() => store.getState().library.folder).toBe('/photos/match-a');
      const target = store.getLibraryPhotos()[1_200]!;
      store.select(target.id);

      store.setModule('develop');
      await expect.poll(() => store.getState().developWindow?.total).toBe(2_500);
      state = store.getState();
      expect(state.photos.every((entry) => entry.path.includes('/match-a/'))).toBe(true);
      expect(state.photos.some((entry) => entry.id === target.id)).toBe(true);
      expect(state.selectedId).toBe(target.id);
      expect(state.developWindow?.offset).toBeLessThanOrEqual(1_200);
      expect((state.developWindow?.offset ?? 0) + state.photos.length).toBeGreaterThan(1_200);
    } finally {
      await store.dispose();
    }
  });

  it('walks every photo in order with the arrow keys, across both page edges', async () => {
    const { store } = world();
    try {
      await store.init();
      store.setModule('library');
      await expect.poll(() => store.getState().photos.length).toBe(2_500);
      store.setLibraryFolder('/photos/match-a');
      await expect.poll(() => store.getState().library.folder).toBe('/photos/match-a');
      store.select(expectedOrder[0]!);
      store.setModule('develop');
      await expect.poll(() => store.getState().developWindow?.total).toBe(2_500);

      const visited: PhotoId[] = [expectedOrder[0]!];
      for (let step = 1; step < expectedOrder.length; step += 1) {
        const previous = store.getState().selectedId;
        store.selectRelative(1);
        await expect.poll(() => store.getState().selectedId).not.toBe(previous);
        visited.push(store.getState().selectedId!);
      }
      expect(visited).toEqual(expectedOrder);

      const back: PhotoId[] = [visited.at(-1)!];
      for (let step = 1; step < expectedOrder.length; step += 1) {
        const previous = store.getState().selectedId;
        store.selectRelative(-1);
        await expect.poll(() => store.getState().selectedId).not.toBe(previous);
        back.push(store.getState().selectedId!);
      }
      expect(back).toEqual([...expectedOrder].reverse());
    } finally {
      await store.dispose();
    }
  }, 120_000);

  it('keeps a selection larger than the page and exports every selected id', async () => {
    const { store, fake } = world();
    try {
      await store.init();
      store.setModule('library');
      await expect.poll(() => store.getState().photos.length).toBe(2_500);
      store.setLibraryFolder('/photos/match-a');
      await expect.poll(() => store.getState().library.folder).toBe('/photos/match-a');
      store.selectAllInLibrary();
      expect(store.getState().selection).toHaveLength(2_500);

      store.setModule('develop');
      await expect.poll(() => store.getState().photos.length).toBe(1_000);
      expect(store.getState().selection).toHaveLength(2_500);

      await store.exportSelected(false);
      const start = fake.calls.filter((call) => call.channel === 'export:start').at(-1)?.args[0] as
        { photoIds: PhotoId[] } | undefined;
      expect(start?.photoIds).toHaveLength(2_500);
      expect(new Set(start?.photoIds)).toEqual(new Set(expectedOrder));

      // The selection is still the whole folder after the trip through the page.
      store.setModule('library');
      await expect.poll(() => store.getState().photos.length).toBe(2_500);
      expect(store.getState().selection).toHaveLength(2_500);
      store.toggleTag();
      await expect
        .poll(
          () =>
            (
              fake.calls.filter((call) => call.channel === 'photos:setLabels').at(-1)?.args[0] as
                { photoIds: PhotoId[] } | undefined
            )?.photoIds.length ?? 0,
        )
        .toBe(2_500);
      const labels = fake.calls.filter((call) => call.channel === 'photos:setLabels').at(-1)
        ?.args[0] as { photoIds: PhotoId[] } | undefined;
      expect(new Set(labels?.photoIds)).toEqual(new Set(expectedOrder));
    } finally {
      await store.dispose();
    }
  }, 60_000);

  it('does not append out-of-scope events to the page, and reloads at most once a second', async () => {
    const { store, fake } = world();
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      await store.init();
      await sleep(300);
      const before = store.getState().photos.length;
      const queryCalls = (): number =>
        fake.calls.filter((call) => call.channel === 'photos:query').length;
      const started = queryCalls();
      for (let index = 0; index < 5; index += 1) {
        fake.emit('photos:added', photo(9_000 + index, 'match-b'));
      }
      await sleep(100);
      expect(store.getState().photos.length).toBeLessThanOrEqual(before);
      const firstReloads = queryCalls() - started;
      expect(firstReloads).toBeLessThanOrEqual(1);
      await sleep(1_100);
      expect(queryCalls() - started - firstReloads).toBeLessThanOrEqual(1);
    } finally {
      await store.dispose();
    }
  }, 30_000);

  it('takes the filter counts and camera menu from the index facets', async () => {
    const { store } = world();
    try {
      await store.init();
      await expect.poll(() => store.getState().facets?.scopeTotal).toBe(2_600);
      expect(store.getState().facets?.cameras.length).toBe(0);

      store.setModule('library');
      await expect.poll(() => store.getState().library.folder).toBe('/photos/match-a');
      await expect.poll(() => store.getState().facets?.scopeTotal).toBe(2_500);
      store.clickRatingStar(4);
      await expect.poll(() => store.getState().facets?.shown).toBe(500);
      expect(store.getState().facets?.tag).toEqual({ all: 500, tagged: 167, untagged: 333 });
      expect(store.getState().facets?.status['not-sent']).toBe(500);
    } finally {
      await store.dispose();
    }
  }, 60_000);

  it('treats page rows as full photos, with no summary fetch on selection', async () => {
    const { store, fake } = world();
    try {
      await store.init();
      const getCalls = fake.calls.filter((call) => call.channel === 'photos:get').length;
      const open = store.getState().selectedId!;
      store.select(undefined);
      store.select(open);
      store.select(undefined);
      store.select(open);
      expect(fake.calls.filter((call) => call.channel === 'photos:get')).toHaveLength(getCalls);
    } finally {
      await store.dispose();
    }
  });

  it('moves to the next photo across a page edge with Next & send', async () => {
    const { store } = world();
    try {
      await store.init();
      store.setModule('library');
      await expect.poll(() => store.getState().photos.length).toBe(2_500);
      store.setLibraryFolder('/photos/match-a');
      await expect.poll(() => store.getState().library.folder).toBe('/photos/match-a');
      // The last photo of the first page, with a page behind it.
      store.select(expectedOrder[999]!);
      store.setModule('develop');
      await expect.poll(() => store.getState().developWindow?.total).toBe(2_500);
      await expect.poll(() => store.getState().photos.length).toBe(1_000);
      await store.nextAndSend();
      await expect.poll(() => store.getState().selectedId).toBe(expectedOrder[1_000]);
    } finally {
      await store.dispose();
    }
  }, 60_000);
});
