import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(develop).toContain('Sort: Name');
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

  it('ticks several statuses from the menu, with counts, and says what they mean', async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: /Status/ }));
    const menu = within(screen.getByRole('menu'));
    expect(menu.getByText('Matches all ticked')).toBeTruthy();
    expect(menu.getAllByRole('menuitemcheckbox').map((item) => item.textContent)).toEqual([
      'Not sent38',
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

  it('sorts from a compact menu', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: 'Sort: Name' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Time' }));
    expect(store.getState().sort).toBe('capture-time');
    expect(bar().getByRole('button', { name: 'Sort: Time' })).toBeTruthy();
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
    expect(store.getState().filter.minRating).toBe(0);
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
