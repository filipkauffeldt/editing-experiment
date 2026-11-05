import type { Photo } from '@ee/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activePhoto,
  createAppStore,
  selectLibraryPhotos,
  selectVisiblePhotos,
  type AppStore,
} from '../src/renderer/store';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function setup(
  options: Parameters<typeof createFakeBridge>[0] = {},
): Promise<{ store: AppStore; fake: FakeBridge }> {
  // The mock photos carry some ratings; these tests set their own from a clean slate.
  const fake = createFakeBridge({
    photos: mockPhotos().map((photo) => ({ ...photo, rating: 0 })),
    ...options,
  });
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  await store.init();
  return { store, fake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const develop = (store: AppStore): string[] =>
  selectVisiblePhotos(store.getState()).map((photo) => photo.fileName);
const library = (store: AppStore): string[] =>
  selectLibraryPhotos(store.getState()).map((photo) => photo.fileName);
const active = (store: AppStore): string | undefined => activePhoto(store.getState())?.fileName;

/** Give the first photos of the list the ratings 5, 3, 3, 1, then unrated ones. */
function rate(store: AppStore, ratings: number[]): Photo[] {
  const photos = selectVisiblePhotos(store.getState());
  ratings.forEach((rating, index) => {
    const photo = photos[index];
    if (photo) store.setRating(rating, photo.id);
  });
  return photos;
}

describe('one filter for both views', () => {
  it('keeps the filter when the module changes, and both views list the same photos', async () => {
    const { store } = await setup();
    rate(store, [5, 3, 3, 1]);
    store.setMinRating(3);
    const expected = develop(store);
    expect(expected).toHaveLength(3);

    store.setModule('library');
    expect(store.getState().filter.minRating).toBe(3);
    expect(library(store)).toEqual(expected);
    store.setModule('develop');
    expect(develop(store)).toEqual(expected);
  });

  it('steps with the arrow keys only through the filtered photos, in Develop and the Library', async () => {
    const { store } = await setup();
    const photos = rate(store, [5, 1, 3, 1, 4]);
    store.setMinRating(3);
    const shown = [photos[0], photos[2], photos[4]].map((photo) => photo?.fileName);

    store.setModule('develop');
    expect(active(store)).toBe(shown[0]);
    store.selectRelative(1);
    expect(active(store)).toBe(shown[1]);
    store.selectRelative(1);
    expect(active(store)).toBe(shown[2]);
    store.selectRelative(1);
    expect(active(store)).toBe(shown[2]);
    store.selectRelative(-1);
    expect(active(store)).toBe(shown[1]);

    store.setModule('library');
    store.moveInLibrary(-1);
    expect(active(store)).toBe(shown[0]);
    store.moveInLibrary(1);
    expect(active(store)).toBe(shown[1]);
  });

  it('keeps the Library folder out of Develop, and applies the filter inside the folder', async () => {
    const { store } = await setup();
    const photos = rate(store, [4, 4]);
    store.setMinRating(4);
    const folder = photos[0]?.path.replace(/[\\/][^\\/]*$/, '');
    store.setLibraryFolder(folder);
    expect(library(store)).toEqual(develop(store));
    store.setLibraryFolder('/somewhere/else');
    expect(library(store)).toEqual([]);
    expect(develop(store)).toHaveLength(2);
  });
});

describe('when a filter hides the active photo', () => {
  it('moves the active photo and the selection to the first photo still shown', async () => {
    const { store } = await setup();
    const photos = rate(store, [1, 5, 5]);
    store.select(photos[0]?.id ?? ('' as never));
    store.select(photos[1]?.id ?? ('' as never), 'range');
    expect(store.getState().selection).toHaveLength(2);

    store.setMinRating(5);
    // The rule: the first photo still shown becomes active and the only one selected.
    expect(active(store)).toBe(photos[1]?.fileName);
    expect(store.getState().selection).toEqual([photos[1]?.id]);
  });

  it('keeps the active photo when it still matches, and prunes the hidden ones from the selection', async () => {
    const { store } = await setup();
    const photos = rate(store, [5, 1, 5]);
    store.setModule('library');
    store.select(photos[0]?.id ?? ('' as never));
    store.select(photos[1]?.id ?? ('' as never), 'range');
    store.select(photos[0]?.id ?? ('' as never));
    store.select(photos[2]?.id ?? ('' as never), 'toggle');
    store.select(photos[1]?.id ?? ('' as never), 'toggle');
    store.setMinRating(5);
    expect(store.getState().selection.every((id) => id !== photos[1]?.id)).toBe(true);
    expect(library(store)).toContain(active(store));
  });

  it('leaves no active photo when nothing matches, and brings one back on clear', async () => {
    const { store } = await setup();
    store.setMinRating(5);
    expect(develop(store)).toEqual([]);
    expect(active(store)).toBeUndefined();
    expect(store.getState().selection).toEqual([]);

    store.clearFilters();
    expect(develop(store)).toHaveLength(40);
    expect(active(store)).toBeDefined();
  });

  it('does the same when a rating change makes the open photo drop out in Develop', async () => {
    const { store } = await setup();
    const photos = rate(store, [4, 4]);
    store.setMinRating(4);
    store.setModule('develop');
    expect(active(store)).toBe(photos[0]?.fileName);
    store.setRating(1);
    expect(active(store)).toBe(photos[1]?.fileName);
  });
});

describe('clear', () => {
  it('resets every filter at once but not the sort', async () => {
    const { store } = await setup();
    store.setSort('capture-time');
    store.setTagFilter('tagged');
    store.setMinRating(2);
    store.toggleColorFilter(3);
    store.toggleStatusFilter('edited');
    store.setCameraFilter('x|y');
    store.setSearch('abc');
    store.clearFilters();
    const { filter, sort, searchResult } = store.getState();
    expect(filter).toEqual({
      tag: 'all',
      minRating: 0,
      colorClasses: [],
      statuses: [],
      search: '',
    });
    expect(searchResult).toBeUndefined();
    expect(sort).toBe('capture-time');
  });
});

describe('search', () => {
  const write = async (fake: FakeBridge, name: string, fields: object): Promise<string> => {
    const photo = (await fake.bridge.invoke('photos:list')).find((p) => p.fileName === name);
    if (!photo) throw new Error(`no ${name}`);
    await fake.bridge.invoke('metadata:write', { photoId: photo.id, fields });
    return photo.id;
  };
  const settle = (store: AppStore) =>
    vi.waitFor(() => expect(store.getState().searchResult).toBeDefined());

  it('finds photos across the whole library by caption, keywords and file name, with å, ä and ö', async () => {
    const { store, fake } = await setup();
    const far = await write(fake, '_DSC9215.NEF', {
      caption: 'Målvakten räddar',
      keywords: ['Åkerlund'],
    });
    // A photo in the other folder and not the active one: search is not limited to what was loaded.
    store.setSearch('åkerlund');
    await settle(store);
    expect(selectVisiblePhotos(store.getState()).map((photo) => photo.id)).toEqual([far]);

    store.setSearch('ÅKERLUND målvakt');
    await vi.waitFor(() => expect(store.getState().searchResult?.query).toBe('ÅKERLUND målvakt'));
    expect(selectVisiblePhotos(store.getState()).map((photo) => photo.id)).toEqual([far]);

    store.setSearch('akerlund');
    await vi.waitFor(() => expect(store.getState().searchResult?.query).toBe('akerlund'));
    expect(develop(store)).toEqual([]);

    store.setSearch('_DSC9215');
    await vi.waitFor(() => expect(store.getState().searchResult?.query).toBe('_DSC9215'));
    expect(develop(store)).toEqual(['_DSC9215.NEF']);
    expect(library(store)).toEqual(['_DSC9215.NEF']);
  });

  it('combines with the other filters and clears without asking the backend', async () => {
    const { store, fake } = await setup();
    await write(fake, '_DSC9215.NEF', { caption: 'Hörnor' });
    await write(fake, '_DSC9216.NEF', { caption: 'Hörnor' });
    store.setSearch('hörnor');
    await settle(store);
    expect(develop(store)).toHaveLength(2);
    store.setTagFilter('tagged');
    expect(develop(store)).toHaveLength(0);
    store.setTagFilter('all');

    const calls = fake.calls.filter((call) => call.channel === 'photos:search').length;
    store.setSearch('');
    expect(store.getState().searchResult).toBeUndefined();
    expect(develop(store)).toHaveLength(40);
    expect(fake.calls.filter((call) => call.channel === 'photos:search')).toHaveLength(calls);
  });

  it('asks again while the backend is still reading captions, and ignores an old answer', async () => {
    let pending = 3;
    const queries: string[] = [];
    const { store } = await setup({
      handlers: {
        'photos:search': async (...args) => {
          queries.push((args[0] as { query: string }).query);
          pending = Math.max(0, pending - 1);
          return { photoIds: [], pending };
        },
      },
    });
    store.setSearch('x');
    await vi.waitFor(() => expect(queries.length).toBeGreaterThanOrEqual(3), { timeout: 4000 });
    expect(store.getState().searchResult?.pending).toBe(0);
  });

  it('does not let a slow answer for an older text replace the newer one', async () => {
    let release!: (value: { photoIds: never[]; pending: number }) => void;
    const slow = new Promise<{ photoIds: never[]; pending: number }>((resolve) => (release = resolve));
    const { store, fake } = await setup({
      handlers: {
        'photos:search': async (...args) => {
          const { query } = args[0] as { query: string };
          if (query === 'old') return slow;
          return { photoIds: [], pending: 0 };
        },
      },
    });
    void fake;
    store.setSearch('old');
    store.setSearch('new');
    await vi.waitFor(() => expect(store.getState().searchResult?.query).toBe('new'));
    release({ photoIds: [], pending: 0 });
    await Promise.resolve();
    expect(store.getState().searchResult?.query).toBe('new');
  });
});
