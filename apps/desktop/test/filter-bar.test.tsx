import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
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

async function renderApp(): Promise<{ store: AppStore; fake: FakeBridge }> {
  const fake = createFakeBridge({
    photos: mockPhotos().map((photo) => ({ ...photo, rating: 0 })),
  });
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  return { store, fake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const bar = () => within(screen.getByTestId('filter-bar'));
const count = (): string => screen.getByTestId('filter-count').textContent ?? '';
// The film strip and the grid are virtualised, so what they show is read from the store's lists.
const stripNames = (): string[] =>
  selectVisiblePhotos(stores[0]?.getState() as never).map((photo) => photo.fileName);
const cellNames = (): string[] =>
  selectLibraryPhotos(stores[0]?.getState() as never).map((photo) => photo.fileName);
const search = (): HTMLInputElement => screen.getByTestId('filter-search') as HTMLInputElement;

/** Rate the first photos of the list 4, 4, 2 so there is something to filter. */
function rate(store: AppStore): void {
  const ids = store.getVisiblePhotos().map((photo) => photo.id);
  store.setRating(4, ids[0]);
  store.setRating(4, ids[1]);
  store.setRating(2, ids[2]);
}

describe('the filter bar in Develop and in the Library', () => {
  it('has the same controls in both views, in the same order', async () => {
    await renderApp();
    // The shared controls: everything but the view's own slot on the right.
    const shared = (): (string | null)[] =>
      bar()
        .getAllByRole('button')
        .filter((button) => !button.closest('[data-testid="filter-slot"]'))
        .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    const develop = shared();
    // Develop keeps its export actions in the slot.
    const developSlot = within(screen.getByTestId('filter-slot'));
    expect(developSlot.getByTestId('open-export')).toBeTruthy();
    expect(developSlot.getByTestId('next-send')).toBeTruthy();
    await userEvent.setup().keyboard('g');
    await screen.findByTestId('library-grid');
    const library = shared();
    expect(library).toEqual(develop);
    expect(develop.slice(0, 3)).toEqual(['All40', 'Tagged4', 'Untagged36']);
    expect(develop).toContain('5 stars and up');
    expect(develop.filter((label) => label?.startsWith('Colour label '))).toHaveLength(8);
    expect(develop).toContain('Status');
    expect(develop).toContain('Camera');
    expect(develop).toContain('Sort: Time');
    // The Library keeps its thumbnail size in the bar's slot.
    expect(within(screen.getByTestId('filter-slot')).getByText('Size')).toBeTruthy();
  });

  it('filters by stars: a click means N and up, the same star clears, unrated is excluded', async () => {
    const { store } = await renderApp();
    rate(store);
    const user = userEvent.setup();
    expect(stripNames()).toHaveLength(40);

    await user.click(bar().getByRole('button', { name: '3 stars and up' }));
    await waitFor(() => expect(stripNames()).toHaveLength(2));
    expect(count()).toBe('2 of 40');

    await user.click(bar().getByRole('button', { name: '2 stars and up' }));
    await waitFor(() => expect(stripNames()).toHaveLength(3));

    await user.click(bar().getByRole('button', { name: '2 stars and up' }));
    await waitFor(() => expect(stripNames()).toHaveLength(40));
    expect(screen.queryByTestId('filter-clear')).toBeNull();
    expect(count()).toBe('40');
  });

  it('picks how the stars compare from a compact selector', async () => {
    const { store } = await renderApp();
    rate(store);
    const user = userEvent.setup();
    const mode = () => bar().getByTestId('filter-rating-mode');
    expect(within(mode()).getByRole('button').textContent).toBe('And up');

    await user.click(within(mode()).getByRole('button'));
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'And up',
      'Exactly',
      'At most',
      'Unrated',
    ]);
    await user.click(screen.getByRole('menuitemradio', { name: 'Exactly' }));
    // The menu closes after a pick and nothing is filtered until a star is clicked.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(stripNames()).toHaveLength(40);
    expect(bar().getByRole('button', { name: '4 stars exactly' })).toBeTruthy();

    await user.click(bar().getByRole('button', { name: '4 stars exactly' }));
    await waitFor(() => expect(stripNames()).toHaveLength(2));
    expect(count()).toBe('2 of 40');

    // Changing the mode keeps the star: at most 4 stars is every photo here.
    await user.click(within(mode()).getByRole('button'));
    await user.click(screen.getByRole('menuitemradio', { name: 'At most' }));
    await waitFor(() => expect(stripNames()).toHaveLength(40));

    await user.click(bar().getByRole('button', { name: '2 stars at most' }));
    await waitFor(() => expect(stripNames()).toHaveLength(38));

    await user.click(within(mode()).getByRole('button'));
    await user.click(screen.getByRole('menuitemradio', { name: 'Unrated' }));
    await waitFor(() => expect(stripNames()).toHaveLength(37));
    expect(count()).toBe('37 of 40');
    for (const star of bar().getAllByRole('button', { name: /^\d stars? /u })) {
      expect(star.getAttribute('aria-pressed')).toBe('false');
    }
    // A star after Unrated goes back to "and up".
    await user.click(bar().getByRole('button', { name: '3 stars and up' }));
    await waitFor(() => expect(stripNames()).toHaveLength(2));
    expect(store.getState().filter.ratingMode).toBe('min');
  });

  it('filter to 3 stars, press D, and the arrow keys step only through those', async () => {
    const { store } = await renderApp();
    rate(store);
    const user = userEvent.setup();
    await user.keyboard('g');
    await screen.findByTestId('library-grid');
    await user.click(bar().getByRole('button', { name: '3 stars and up' }));
    await waitFor(() => expect(cellNames()).toHaveLength(2));

    await user.keyboard('d');
    await screen.findByTestId('film-strip');
    const shown = stripNames();
    expect(shown).toHaveLength(2);
    expect(bar().getByRole('button', { name: '3 stars and up' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(activePhoto(store.getState())?.fileName).toBe(shown[0]);
    await user.keyboard('{ArrowRight}');
    expect(activePhoto(store.getState())?.fileName).toBe(shown[1]);
    await user.keyboard('{ArrowRight}');
    expect(activePhoto(store.getState())?.fileName).toBe(shown[1]);
    await user.keyboard('{ArrowLeft}');
    expect(activePhoto(store.getState())?.fileName).toBe(shown[0]);
  });

  it('keeps 1-5 as the rating shortcut', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.keyboard('4');
    expect(activePhoto(store.getState())?.rating).toBe(4);
  });

  it('shows several colour classes at once', async () => {
    const { store } = await renderApp();
    const ids = store.getVisiblePhotos().map((photo) => photo.id);
    store.setColorClass(1, ids[0]);
    store.setColorClass(3, ids[1]);
    store.setColorClass(5, ids[2]);
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: 'Colour label 1' }));
    await user.click(bar().getByRole('button', { name: 'Colour label 5' }));
    await waitFor(() => expect(stripNames()).toHaveLength(2));
    await user.click(bar().getByRole('button', { name: 'Colour label 1' }));
    await waitFor(() => expect(stripNames()).toHaveLength(1));
  });

  it('cycles a colour through shown, hidden and off', async () => {
    const { store } = await renderApp();
    const ids = store.getVisiblePhotos().map((photo) => photo.id);
    store.setColorClass(1, ids[0]);
    store.setColorClass(1, ids[1]);
    store.setColorClass(3, ids[2]);
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: 'Colour label 1' }));
    await waitFor(() => expect(stripNames()).toHaveLength(2));
    expect(bar().getByRole('button', { name: 'Colour label 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await user.click(bar().getByRole('button', { name: 'Colour label 1' }));
    // Hidden now: the other 38 photos stay, labelled or not.
    await waitFor(() => expect(stripNames()).toHaveLength(38));
    const struck = bar().getByRole('button', { name: 'Colour label 1 excluded' });
    expect(struck.getAttribute('aria-pressed')).toBe('false');
    expect(struck.getAttribute('title')).toContain('click to clear');
    expect(count()).toBe('38 of 40');
    expect(screen.getByTestId('filter-clear')).toBeTruthy();

    await user.click(bar().getByRole('button', { name: 'Colour label 3' }));
    await user.click(bar().getByRole('button', { name: 'Colour label 3' }));
    await waitFor(() => expect(stripNames()).toHaveLength(37));

    await user.click(struck);
    await waitFor(() => expect(stripNames()).toHaveLength(39));
    expect(bar().getByRole('button', { name: 'Colour label 1' })).toBeTruthy();
  });

  it('ticks several statuses from the menu, with counts, and says what they mean', async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: /Status/ }));
    const menu = within(screen.getByRole('menu'));
    expect(menu.getByText('Matches all ticked')).toBeTruthy();
    expect(menu.getAllByRole('menuitemcheckbox').map((item) => item.textContent)).toEqual([
      'Not sent38',
      'Not exported36',
      'Exported4',
      'Failed1',
      'Edited7',
      'Differs from template1',
    ]);
    await user.click(menu.getByRole('menuitemcheckbox', { name: /Edited/ }));
    await waitFor(() => expect(stripNames()).toHaveLength(7));
    await user.click(menu.getByRole('menuitemcheckbox', { name: /Failed/ }));
    // Edited and failed upload: none of the seven edited photos failed.
    await waitFor(() => expect(screen.getByTestId('filter-empty')).toBeTruthy());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('filters on export status and keeps the counts honest', async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: /Status/ }));
    const menu = within(screen.getByRole('menu'));
    await user.click(menu.getByRole('menuitemcheckbox', { name: /^Exported/ }));
    await waitFor(() => expect(stripNames()).toHaveLength(4));
    expect(count()).toBe('4 of 40');
    // With Exported ticked, Not exported would show nothing on top of it.
    expect(menu.getByRole('menuitemcheckbox', { name: /^Not exported/ }).textContent).toBe(
      'Not exported0',
    );
    await user.click(menu.getByRole('menuitemcheckbox', { name: /^Exported/ }));
    await user.click(menu.getByRole('menuitemcheckbox', { name: /^Not exported/ }));
    await waitFor(() => expect(stripNames()).toHaveLength(36));
  });

  it('saves a filter under a name, picks it again, renames it and deletes it', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const saved = () => bar().getByTestId('filter-saved');
    const open = () => user.click(within(saved()).getByRole('button'));

    // Nothing to save while nothing is filtered.
    await open();
    expect(screen.getByText('Nothing saved yet')).toBeTruthy();
    expect(
      (screen.getByLabelText('Name for the current filter') as HTMLInputElement).disabled,
    ).toBe(true);
    await user.keyboard('{Escape}');

    await user.click(bar().getByRole('button', { name: /^Tagged/ }));
    await user.click(bar().getByRole('button', { name: '5 stars and up' }));
    await open();
    await user.type(screen.getByLabelText('Name for the current filter'), 'Tagged fives{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Tagged fives' })).toBeTruthy(),
    );
    expect(store.getState().settings?.savedFilters?.map((entry) => entry.name)).toEqual([
      'Tagged fives',
    ]);
    // It is the filter on screen, so it is marked as the one in use.
    expect(
      screen.getByRole('menuitem', { name: 'Tagged fives' }).getAttribute('aria-current'),
    ).toBe('true');
    await user.keyboard('{Escape}');

    await user.click(screen.getByTestId('filter-clear'));
    await waitFor(() => expect(stripNames()).toHaveLength(40));
    await open();
    await user.click(screen.getByRole('menuitem', { name: 'Tagged fives' }));
    // Picking closes the menu and sets the filter again.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(store.getState().filter).toMatchObject({ tag: 'tagged', ratingStars: 5 });
    expect(bar().getByRole('button', { name: '5 stars and up' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await open();
    await user.click(screen.getByRole('button', { name: 'Rename Tagged fives' }));
    const field = screen.getByLabelText('New name for Tagged fives');
    await user.clear(field);
    await user.type(field, 'Best{Enter}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Best' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Delete Best' }));
    await waitFor(() => expect(screen.getByText('Nothing saved yet')).toBeTruthy());
    expect(store.getState().settings?.savedFilters ?? []).toEqual([]);
    // Deleting a saved filter does not touch the filter on screen.
    expect(store.getState().filter.tag).toBe('tagged');
  });

  describe('where the menus open', () => {
    /**
     * jsdom has no layout, so the filter bar is given a place in the window: `top` is where its
     * buttons are, and every menu list is 200 px tall. The window is 768 px high.
     */
    const placeFilterBar = (top: number): void => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const inBar = this.closest('[data-testid="filter-bar"]') !== null;
        return {
          top: inBar ? top : 0,
          bottom: inBar ? top + 20 : 0,
          left: 0,
          right: 0,
          width: 0,
          height: inBar ? 20 : 0,
          x: 0,
          y: inBar ? top : 0,
          toJSON: () => ({}),
        };
      });
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.getAttribute('role') === 'menu' ? 200 : 0;
      });
    };
    afterEach(() => vi.restoreAllMocks());

    const opened = async (name: RegExp | string): Promise<string | null> => {
      await userEvent.setup().click(bar().getByRole('button', { name }));
      return screen.getByRole('menu').getAttribute('data-placement');
    };

    it('open upwards in Develop, where the bar is at the bottom, so none runs off the window', async () => {
      await renderApp();
      placeFilterBar(720);
      for (const name of [/^Status/, /^Camera/, /^Saved/, 'Rating: and up']) {
        expect(await opened(name)).toBe('up');
        await userEvent.setup().keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
      }
    });

    it('open downwards in the Library, where the bar is at the top', async () => {
      await renderApp();
      placeFilterBar(40);
      for (const name of [/^Status/, /^Camera/, /^Saved/, 'Rating: and up']) {
        expect(await opened(name)).toBe('down');
        await userEvent.setup().keyboard('{Escape}');
      }
    });

    it('stay downwards when there is no more room above than below', async () => {
      await renderApp();
      // 120 px from the bottom, 650 from the top: the 200 px list does not fit below but there is
      // plenty above, so it flips. Close to the top of a short window it would not.
      placeFilterBar(650);
      expect(await opened(/^Status/)).toBe('up');
      await userEvent.setup().keyboard('{Escape}');
      vi.restoreAllMocks();
      placeFilterBar(30);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(150);
      expect(await opened(/^Status/)).toBe('down');
    });
  });

  it('puts the camera bodies and the sources in one menu', async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: /Camera/ }));
    const menu = within(screen.getByRole('menu'));
    expect(menu.getByText('Source')).toBeTruthy();
    expect(menu.getAllByRole('menuitemradio').length).toBeGreaterThanOrEqual(6);
    await user.click(menu.getAllByRole('menuitemradio', { name: /Z 9/ })[0] as HTMLElement);
    await waitFor(() => expect(stripNames()).toHaveLength(20));
    await user.click(menu.getAllByRole('menuitemradio', { name: /^All bodies/ })[0] as HTMLElement);
    await waitFor(() => expect(stripNames()).toHaveLength(40));
  });

  it('sorts from a compact menu, with Time as the default', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    expect(store.getState().sort).toBe('capture-time');
    await user.click(bar().getByRole('button', { name: 'Sort: Time' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Name' }));
    expect(store.getState().sort).toBe('filename');
    expect(bar().getByRole('button', { name: 'Sort: Name' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows the × only while something is filtered and clears everything', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    expect(screen.queryByTestId('filter-clear')).toBeNull();
    await user.click(bar().getByRole('button', { name: /^Tagged/ }));
    await user.click(bar().getByRole('button', { name: '5 stars and up' }));
    expect(screen.getByTestId('filter-clear')).toBeTruthy();
    await user.click(screen.getByTestId('filter-clear'));
    expect(screen.queryByTestId('filter-clear')).toBeNull();
    expect(store.getState().filter.ratingStars).toBe(0);
    expect(store.getState().filter.tag).toBe('all');
    expect(stripNames()).toHaveLength(40);
  });

  it('says photos are hidden, not lost, when a filter shows none, in both views', async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: '5 stars and up' }));
    const empty = await screen.findByTestId('filter-empty');
    expect(empty.textContent).toContain('40 photos are hidden');
    expect(screen.queryByTestId('film-strip')).toBeNull();

    await user.keyboard('g');
    expect((await screen.findByTestId('filter-empty')).textContent).toContain('hidden');
    expect(screen.queryByTestId('library-grid')).toBeNull();

    await user.click(
      within(screen.getByTestId('filter-empty')).getByRole('button', { name: 'Clear filters' }),
    );
    await screen.findByTestId('library-grid');
    expect(cellNames()).toHaveLength(40);
  });

  it('counts against the folder in the Library', async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.keyboard('g');
    await screen.findByTestId('library-grid');
    await user.click(
      within(screen.getByTestId('library-folders')).getByRole('button', { name: /IFK–AIK20$/ }),
    );
    await waitFor(() => expect(count()).toBe('20'));
  });
});

describe('search box', () => {
  it('searches after a pause, in captions with å, and shows N of M', async () => {
    const { store, fake } = await renderApp();
    const target = store.getVisiblePhotos()[7];
    await fake.bridge.invoke('metadata:write', {
      photoId: target!.id,
      fields: { caption: 'Målvakten Åkerlund räddar', keywords: ['allsvenskan'] },
    });
    const user = userEvent.setup();
    await user.type(search(), 'åkerlund');
    expect(stripNames()).toHaveLength(40);
    await waitFor(() => expect(stripNames()).toEqual([target?.fileName]));
    expect(count()).toBe('1 of 40');
    // Keywords and Latin letters: "akerlund" is a different word.
    await user.clear(search());
    await user.type(search(), 'akerlund');
    await waitFor(() => expect(screen.getByTestId('filter-empty')).toBeTruthy());
  });

  it('fires no shortcut while typing, whatever the letters and digits', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const before = activePhoto(store.getState());
    await user.click(search());
    await user.keyboard('gdetcryjw1234 5{ArrowLeft}{ArrowRight}');
    expect(store.getState().module).toBe('develop');
    expect(store.getState().crop).toBeUndefined();
    expect(store.getState().retouch).toBeUndefined();
    expect(activePhoto(store.getState())?.id).toBe(before?.id);
    expect(activePhoto(store.getState())?.rating).toBe(before?.rating);
    expect(activePhoto(store.getState())?.tagged).toBe(before?.tagged);
    expect(search().value).toBe('gdetcryjw1234 5');
  });

  it('clears on Escape, leaves the field, and does nothing else', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.keyboard('g');
    await screen.findByTestId('library-grid');
    const ids = cellNames().map(
      (name) => store.getState().photos.find((photo) => photo.fileName === name)?.id,
    );
    store.select(ids[0] as never);
    store.select(ids[2] as never, 'range');
    const selected = store.getState().selection.length;
    expect(selected).toBeGreaterThan(1);

    await user.click(search());
    // Every file name matches, so the selection survives the search itself.
    await user.keyboard('_dsc');
    await waitFor(() => expect(store.getState().searchResult?.query).toBe('_dsc'));
    await user.keyboard('{Escape}');
    expect(search().value).toBe('');
    expect(store.getState().filter.search).toBe('');
    expect(document.activeElement).not.toBe(search());
    // Esc normally collapses a multi-selection; it must not here.
    expect(store.getState().selection).toHaveLength(selected);
  });

  it('applies at once on Enter and hands the keys back to the photos', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.click(search());
    await user.keyboard('_DSC8331{Enter}');
    expect(store.getState().filter.search).toBe('_DSC8331');
    expect(document.activeElement).not.toBe(search());
  });

  it('Ctrl+F focuses the search in both views and is listed in the shortcuts', async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.keyboard('{Control>}f{/Control}');
    expect(document.activeElement).toBe(search());
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('g');
    await screen.findByTestId('library-grid');
    await user.keyboard('{Control>}f{/Control}');
    expect(document.activeElement).toBe(search());

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: '?' });
    const overlay = await screen.findByTestId('shortcuts-overlay');
    expect(within(overlay).getByText('Ctrl/⌘ + F')).toBeTruthy();
  });

  it('follows a clear from outside the field', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.type(search(), 'abc');
    await waitFor(() => expect(store.getState().filter.search).toBe('abc'));
    await user.click(screen.getByTestId('filter-clear'));
    expect(search().value).toBe('');
  });
});

describe('Library sidebar', () => {
  it('is folders only: no Collections and no Ingesting block', async () => {
    await renderApp();
    await userEvent.setup().keyboard('g');
    const sidebar = await screen.findByTestId('library-sidebar');
    expect(
      within(sidebar)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['Folders']);
    expect(within(sidebar).queryByText('Collections')).toBeNull();
    expect(within(sidebar).queryByText(/Ingest/)).toBeNull();
  });
});
