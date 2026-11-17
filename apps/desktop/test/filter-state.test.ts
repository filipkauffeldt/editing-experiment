import type { Photo } from '@ee/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activePhoto,
  createAppStore,
  selectLibraryPhotos,
  selectVisiblePhotos,
  type AppStore,
} from '../src/renderer/store';
import { initialFilter } from '../src/renderer/filters';
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
    store.clickRatingStar(3);
    const expected = develop(store);
    expect(expected).toHaveLength(3);

    store.setModule('library');
    expect(store.getState().filter.ratingStars).toBe(3);
    expect(library(store)).toEqual(expected);
    store.setModule('develop');
    expect(develop(store)).toEqual(expected);
  });

  it('steps with the arrow keys only through the filtered photos, in Develop and the Library', async () => {
    const { store } = await setup();
    const photos = rate(store, [5, 1, 3, 1, 4]);
    store.clickRatingStar(3);
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
    store.clickRatingStar(4);
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

    store.clickRatingStar(5);
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
    store.clickRatingStar(5);
    expect(store.getState().selection.every((id) => id !== photos[1]?.id)).toBe(true);
    expect(library(store)).toContain(active(store));
  });

  it('leaves no active photo when nothing matches, and brings one back on clear', async () => {
    const { store } = await setup();
    store.clickRatingStar(5);
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
    store.clickRatingStar(4);
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
    store.clickRatingStar(2);
    store.cycleColorFilter(3);
    store.cycleColorFilter(4);
    store.cycleColorFilter(4);
    store.toggleStatusFilter('edited');
    store.setCameraFilter('x|y');
    store.setSearch('abc');
    store.clearFilters();
    const { filter, sort, searchResult } = store.getState();
    expect(filter).toEqual({
      tag: 'all',
      ratingStars: 0,
      ratingMode: 'min',
      colorClasses: [],
      excludedColors: [],
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
    const slow = new Promise<{ photoIds: never[]; pending: number }>(
      (resolve) => (release = resolve),
    );
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

/** A second app start on the same backend: what the settings kept is all it has. */
async function restart(
  fake: FakeBridge,
  options: Parameters<typeof createAppStore>[1] = {},
): Promise<AppStore> {
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    ...options,
  });
  stores.push(store);
  await store.init();
  return store;
}

const savedNames = (store: AppStore): string[] =>
  (store.getState().settings?.savedFilters ?? []).map((entry) => entry.name);

describe('saved filters', () => {
  it('saves the current filter under a name and keeps it for the next start', async () => {
    const { store, fake } = await setup();
    store.clickRatingStar(3);
    store.setRatingMode('exact');
    store.cycleColorFilter(1);
    store.cycleColorFilter(1);
    store.toggleStatusFilter('not-exported');
    await store.saveFilter('  Keepers not exported  ');

    expect(savedNames(store)).toEqual(['Keepers not exported']);
    const entry = store.getState().settings?.savedFilters?.[0];
    expect(entry?.filter).toMatchObject({
      ratingStars: 3,
      ratingMode: 'exact',
      excludedColors: [1],
      statuses: ['not-exported'],
    });
    expect(fake.settings.savedFilters).toHaveLength(1);

    const next = await restart(fake);
    expect(savedNames(next)).toEqual(['Keepers not exported']);
  });

  it('replaces the whole filter when one is picked, and leaves the saved one alone afterwards', async () => {
    const { store } = await setup();
    store.setTagFilter('tagged');
    store.cycleColorFilter(2);
    await store.saveFilter('Tagged green');
    const saved = store.getState().settings?.savedFilters?.[0];
    if (!saved) throw new Error('not saved');

    store.clearFilters();
    store.clickRatingStar(5);
    store.toggleStatusFilter('edited');
    store.applySavedFilter(saved.id);
    expect(store.getState().filter).toEqual({
      ...initialFilter(),
      tag: 'tagged',
      colorClasses: [2],
    });

    store.setTagFilter('untagged');
    store.cycleColorFilter(4);
    expect(store.getState().settings?.savedFilters?.[0]?.filter).toEqual(saved.filter);
    expect(store.getState().settings?.savedFilters?.[0]?.filter.tag).toBe('tagged');
  });

  it('keeps the search text in a saved filter and runs the search when it is picked', async () => {
    const { store, fake } = await setup();
    const target = (await fake.bridge.invoke('photos:list')).find(
      (p) => p.fileName === '_DSC9215.NEF',
    );
    if (!target) throw new Error('no photo');
    await fake.bridge.invoke('metadata:write', {
      photoId: target.id,
      fields: { caption: 'Hörnor' },
    });
    store.setSearch('hörnor');
    await vi.waitFor(() => expect(store.getState().searchResult?.query).toBe('hörnor'));
    await store.saveFilter('Corners');
    const saved = store.getState().settings?.savedFilters?.[0];
    expect(saved?.filter.search).toBe('hörnor');

    store.clearFilters();
    expect(develop(store)).toHaveLength(40);
    store.applySavedFilter(saved?.id ?? '');
    expect(store.getState().filter.search).toBe('hörnor');
    await vi.waitFor(() => expect(store.getState().searchResult?.query).toBe('hörnor'));
    expect(develop(store)).toEqual(['_DSC9215.NEF']);
  });

  it('does not keep the Library folder in a saved filter or move it when one is picked', async () => {
    const { store } = await setup();
    const folder = store.getVisiblePhotos()[0]?.path.replace(/[\\/][^\\/]*$/, '');
    store.setLibraryFolder(folder);
    store.setTagFilter('tagged');
    await store.saveFilter('Tagged');
    const saved = store.getState().settings?.savedFilters?.[0];
    expect(JSON.stringify(saved)).not.toContain(folder ?? 'no folder');

    store.setLibraryFolder('/somewhere/else');
    store.clearFilters();
    store.applySavedFilter(saved?.id ?? '');
    expect(store.getState().library.folder).toBe('/somewhere/else');
  });

  it('renames, deletes and replaces by name', async () => {
    const { store, fake } = await setup();
    store.setTagFilter('tagged');
    await store.saveFilter('Tagged');
    store.clearFilters();
    store.clickRatingStar(4);
    await store.saveFilter('Four');
    const [tagged, four] = store.getState().settings?.savedFilters ?? [];
    if (!tagged || !four) throw new Error('not saved');

    await store.renameSavedFilter(tagged.id, ' Keepers ');
    expect(savedNames(store)).toEqual(['Keepers', 'Four']);

    // The same name again, in another case, updates that filter and does not add a second.
    store.clearFilters();
    store.clickRatingStar(5);
    await store.saveFilter('FOUR');
    expect(savedNames(store)).toEqual(['Keepers', 'Four']);
    expect(store.getState().settings?.savedFilters?.[1]?.filter.ratingStars).toBe(5);
    expect(store.getState().settings?.savedFilters?.[1]?.id).toBe(four.id);

    await store.renameSavedFilter(four.id, '   ');
    expect(savedNames(store)).toEqual(['Keepers', 'Four']);

    await store.deleteSavedFilter(tagged.id);
    expect(savedNames(store)).toEqual(['Four']);
    expect(savedNames(await restart(fake))).toEqual(['Four']);
    await store.deleteSavedFilter(four.id);
    expect(savedNames(await restart(fake))).toEqual([]);
  });

  it('saves nothing without a name', async () => {
    const { store, fake } = await setup();
    store.setTagFilter('tagged');
    await store.saveFilter('   ');
    expect(savedNames(store)).toEqual([]);
    expect(fake.calls.some((call) => call.channel === 'settings:set')).toBe(false);
  });
});

describe('the remembered filter', () => {
  it('comes back at the next start, and clearing it is remembered too', async () => {
    const { store, fake } = await setup();
    store.setTagFilter('tagged');
    store.clickRatingStar(2);
    store.setRatingMode('max');
    store.cycleColorFilter(3);
    store.cycleColorFilter(3);
    store.toggleStatusFilter('exported');
    store.setCameraFilter('NIKON Z 9|1');
    await store.dispose();
    expect(fake.settings.currentFilter).toMatchObject({
      tag: 'tagged',
      ratingStars: 2,
      ratingMode: 'max',
      excludedColors: [3],
      statuses: ['exported'],
      camera: 'NIKON Z 9|1',
    });

    const next = await restart(fake);
    expect(next.getState().filter).toEqual({
      ...initialFilter(),
      tag: 'tagged',
      ratingStars: 2,
      ratingMode: 'max',
      excludedColors: [3],
      statuses: ['exported'],
      camera: 'NIKON Z 9|1',
    });

    next.clearFilters();
    await next.dispose();
    expect((await restart(fake)).getState().filter).toEqual(initialFilter());
  });

  it('writes a burst of changes once, shortly after the last', async () => {
    const { store, fake } = await setup();
    store.setTagFilter('tagged');
    store.clickRatingStar(4);
    store.cycleColorFilter(1);
    expect(fake.calls.filter((call) => call.channel === 'settings:set')).toHaveLength(0);
    await vi.waitFor(() =>
      expect(fake.calls.filter((call) => call.channel === 'settings:set')).toHaveLength(1),
    );
    expect(fake.settings.currentFilter).toMatchObject({ tag: 'tagged', ratingStars: 4 });
  });

  it('is on screen at the first paint, without a flash of every photo', async () => {
    const { store, fake } = await setup();
    store.setTagFilter('tagged');
    await store.dispose();

    const next = createAppStore(fake.bridge, {
      renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    });
    stores.push(next);
    const paints: { loading: boolean; shown: number; tag: string }[] = [];
    next.subscribe(() => {
      const state = next.getState();
      paints.push({
        loading: state.loading,
        shown: selectVisiblePhotos(state).length,
        tag: state.filter.tag,
      });
    });
    await next.init();
    const loaded = paints.filter((paint) => !paint.loading);
    expect(loaded.length).toBeGreaterThan(0);
    // Every state that has photos in it is already the filtered one.
    expect(loaded.every((paint) => paint.tag === 'tagged' && paint.shown === 4)).toBe(true);
    expect(paints.every((paint) => paint.shown === 0 || paint.tag === 'tagged')).toBe(true);
  });

  it('restores a search before the first paint and runs it once', async () => {
    const { store, fake } = await setup();
    const target = (await fake.bridge.invoke('photos:list')).find(
      (p) => p.fileName === '_DSC9215.NEF',
    );
    if (!target) throw new Error('no photo');
    await fake.bridge.invoke('metadata:write', {
      photoId: target.id,
      fields: { caption: 'Hörnor' },
    });
    store.setSearch('hörnor');
    await vi.waitFor(() => expect(store.getState().searchResult?.query).toBe('hörnor'));
    await store.dispose();
    const before = fake.calls.filter((call) => call.channel === 'photos:search').length;

    const next = await restart(fake);
    expect(develop(next)).toEqual(['_DSC9215.NEF']);
    expect(next.getState().searchResult?.query).toBe('hörnor');
    expect(fake.calls.filter((call) => call.channel === 'photos:search').length - before).toBe(1);
  });

  it('starts unfiltered when nothing was remembered or the remembered filter is empty', async () => {
    const { store, fake } = await setup();
    expect(store.getState().filter).toEqual(initialFilter());
    store.setTagFilter('tagged');
    store.clearFilters();
    await store.dispose();
    const next = await restart(fake);
    expect(next.getState().filter).toEqual(initialFilter());
    expect(develop(next)).toHaveLength(40);
  });

  it('asks the index once for a large library, with the filter, and counts once', async () => {
    const { store, fake } = await setup();
    store.setTagFilter('tagged');
    await store.dispose();
    const before = fake.calls.length;

    const next = await restart(fake, { lazyLibraryPhotos: 0 });
    expect(next.getState().lazy).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = fake.calls.slice(before);
    const queries = after.filter((call) => call.channel === 'photos:query');
    expect(queries).toHaveLength(1);
    expect((queries[0]?.args[0] as { filter?: { tag?: string } }).filter?.tag).toBe('tagged');
    expect(after.filter((call) => call.channel === 'photos:facets')).toHaveLength(1);
    expect(next.getState().photos).toHaveLength(4);
    expect(next.getState().developWindow?.total).toBe(4);
  });

  it('does not write a filter it only restored', async () => {
    const { store, fake } = await setup();
    store.setTagFilter('tagged');
    await store.dispose();
    const before = fake.calls.filter((call) => call.channel === 'settings:set').length;
    const next = await restart(fake);
    await next.dispose();
    expect(fake.calls.filter((call) => call.channel === 'settings:set').length).toBe(before);
  });
});

describe('filters and undo', () => {
  const messages = (store: AppStore): string[] =>
    store.getState().toasts.map((toast) => toast.message);
  const undone = (store: AppStore, text: string) =>
    vi.waitFor(() =>
      expect(messages(store).some((message) => message.startsWith(text))).toBe(true),
    );

  it('does not take a filter change as an undo step', async () => {
    const { store, fake } = await setup();
    store.setTagFilter('tagged');
    store.clickRatingStar(3);
    store.cycleColorFilter(2);
    await store.saveFilter('Tagged');
    store.clearFilters();
    const before = store.getState().filter;
    store.undoLast();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getState().filter).toBe(before);
    expect(messages(store)).toEqual([]);
    expect(fake.calls.filter((call) => call.channel === 'photos:setLabels')).toHaveLength(0);
  });

  it('still undoes a label change made under a filter, and leaves the filter as it is', async () => {
    const { store } = await setup();
    const first = selectVisiblePhotos(store.getState())[0];
    if (!first) throw new Error('no photo');
    store.clickRatingStar(4);
    expect(develop(store)).toEqual([]);

    store.setRating(5, first.id);
    await vi.waitFor(() => expect(develop(store)).toEqual([first.fileName]));
    // Filter changes after the rating are not what an undo takes.
    store.setTagFilter('all');
    store.cycleColorFilter(3);
    store.cycleColorFilter(3);
    const filter = store.getState().filter;

    store.undoLast();
    await undone(store, 'Undid rating');
    expect(store.getState().filter).toBe(filter);
    expect(store.getState().photos.find((photo) => photo.id === first.id)?.rating).toBe(0);
    // The photo no longer passes the star filter that is still on.
    expect(develop(store)).toEqual([]);

    store.redoLast();
    await undone(store, 'Redid rating');
    await vi.waitFor(() => expect(develop(store)).toEqual([first.fileName]));
    expect(store.getState().filter).toBe(filter);
  });

  it('keeps picking a saved filter out of the history too', async () => {
    const { store } = await setup();
    const first = selectVisiblePhotos(store.getState())[0];
    if (!first) throw new Error('no photo');
    store.setTagFilter('tagged');
    await store.saveFilter('Tagged');
    const saved = store.getState().settings?.savedFilters?.[0];
    store.clearFilters();

    store.setColorClass(2, first.id);
    await vi.waitFor(() =>
      expect(store.getState().photos.find((p) => p.id === first.id)?.colorClass).toBe(2),
    );
    store.applySavedFilter(saved?.id ?? '');
    store.undoLast();
    await undone(store, 'Undid colour label');
    expect(store.getState().filter.tag).toBe('tagged');
  });
});
