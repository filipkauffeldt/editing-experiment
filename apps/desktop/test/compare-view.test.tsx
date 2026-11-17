import type { PhotoId } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import {
  COMPARE_HINT,
  COMPARE_ZOOM_KEY,
  compareOrder,
  movedActive,
} from '../src/renderer/compare-view';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { FIT_VIEW } from '../src/renderer/view-transform';
import { setPanHeld, zoomStore } from '../src/renderer/zoom-view';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

/** The app in the Library grid, with the first `count` photos of the grid selected. */
async function openLibrary(
  count: number,
): Promise<{ store: AppStore; ids: PhotoId[]; fake: FakeBridge }> {
  const fake = createFakeBridge();
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  await userEvent.setup().keyboard('g');
  await screen.findByTestId('library-grid');
  const ids = store.getLibraryPhotos().map((photo) => photo.id);
  act(() => {
    store.select(ids[0]!);
    if (count > 1) store.select(ids[count - 1]!, 'range');
  });
  return { store, ids: ids.slice(0, count), fake };
}

afterEach(async () => {
  setPanHeld(false);
  zoomStore.set({ ...zoomStore.get(), key: undefined, view: FIT_VIEW });
  for (const store of stores.splice(0)) await store.dispose();
});

const key = (init: KeyboardEventInit): void => {
  act(() => {
    fireEvent.keyDown(window, init);
  });
};

const panes = (): HTMLElement[] => screen.queryAllByTestId('compare-pane');
const paneIds = (): (string | null)[] => panes().map((pane) => pane.getAttribute('data-photo-id'));
const activeId = (): string | null =>
  panes()
    .find((pane) => pane.getAttribute('data-active') === 'true')
    ?.getAttribute('data-photo-id') ?? null;
const photoOf = (store: AppStore, id: PhotoId) =>
  store.getState().photos.find((photo) => photo.id === id)!;

describe('compare view', () => {
  it.each([2, 3, 4])('opens %i selected photos side by side with V', async (count) => {
    const { ids } = await openLibrary(count);
    await userEvent.setup().keyboard('v');
    const view = await screen.findByTestId('compare-view');
    expect(view.getAttribute('data-count')).toBe(String(count));
    expect(paneIds()).toEqual(ids);
  });

  it('opens from the Compare button', async () => {
    const { ids } = await openLibrary(3);
    const button = screen.getByTestId('compare-button');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.setup().click(button);
    await screen.findByTestId('compare-view');
    expect(paneIds()).toEqual(ids);
  });

  it.each([1, 5])('is disabled with a tooltip for %i selected photos', async (count) => {
    const { store } = await openLibrary(count);
    const button = screen.getByTestId('compare-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(COMPARE_HINT);
    await userEvent.setup().keyboard('v');
    expect(screen.queryByTestId('compare-view')).toBeNull();
    expect(store.getState().library.view).toBe('grid');
  });

  it('starts with the open photo active, and ←/→ and a click move the active pane', async () => {
    const { store, ids } = await openLibrary(3);
    const user = userEvent.setup();
    await user.keyboard('v');
    await screen.findByTestId('compare-view');
    expect(activeId()).toBe(store.getState().selectedId);

    key({ key: 'ArrowLeft' });
    key({ key: 'ArrowLeft' });
    key({ key: 'ArrowLeft' });
    expect(activeId()).toBe(ids[0]);
    key({ key: 'ArrowRight' });
    expect(activeId()).toBe(ids[1]);
    key({ key: 'ArrowRight' });
    key({ key: 'ArrowRight' });
    expect(activeId()).toBe(ids[2]);

    await user.click(panes()[0]!);
    expect(activeId()).toBe(ids[0]);
  });

  it('puts T, the rating and the colour label on the active pane only', async () => {
    const { store, ids } = await openLibrary(3);
    const user = userEvent.setup();
    await user.keyboard('v');
    await screen.findByTestId('compare-view');
    key({ key: 'ArrowRight' });
    const active = activeId() as PhotoId;
    const flagsOf = (id: PhotoId) => {
      const { tagged, rating, colorClass } = photoOf(store, id);
      return { tagged, rating, colorClass };
    };
    const others = ids.filter((id) => id !== active);
    const before = others.map(flagsOf);

    await user.keyboard('t');
    await user.keyboard('4');
    key({ key: '2', code: 'Digit2', ctrlKey: true });

    expect(flagsOf(active)).toEqual({ tagged: true, rating: 4, colorClass: 2 });
    expect(others.map(flagsOf)).toEqual(before);
    const flags = panes()
      .find((pane) => pane.getAttribute('data-photo-id') === active)!
      .querySelector('[data-testid="compare-flags"]')!;
    expect(flags.querySelector('[data-testid="rating-stars"]')?.getAttribute('aria-label')).toBe(
      'Rating 4 of 5',
    );
    expect(flags.querySelector('[title="Tagged"]')).not.toBeNull();
    expect(flags.querySelector('[title^="Colour label 2"]')).not.toBeNull();
  });

  it('shares one zoom across every pane', async () => {
    await openLibrary(4);
    await userEvent.setup().keyboard('v');
    await screen.findByTestId('compare-view');
    const zooms = (): (string | null)[] =>
      screen.getAllByTestId('compare-stage').map((stage) => stage.getAttribute('data-zoom'));
    expect(zooms()).toEqual(['fit', 'fit', 'fit', 'fit']);

    key({ key: 'z', code: 'KeyZ' });
    expect(zoomStore.get().key).toBe(COMPARE_ZOOM_KEY);
    expect(zoomStore.get().view.scale).toBe(1);
    expect(zooms()).toEqual(['100', '100', '100', '100']);

    // Ctrl + wheel on one pane zooms them all.
    const stage = screen.getAllByTestId('compare-stage')[2]!;
    act(() => {
      fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true });
    });
    const after = zooms();
    expect(after[0]).not.toBe('100');
    expect(new Set(after).size).toBe(1);

    key({ key: 'z', code: 'KeyZ' });
    expect(zooms()).toEqual(['fit', 'fit', 'fit', 'fit']);
  });

  it('goes back to the grid on Esc and keeps the selection', async () => {
    const { store, ids } = await openLibrary(3);
    const user = userEvent.setup();
    await user.keyboard('v');
    await screen.findByTestId('compare-view');
    const selection = store.getState().selection;
    expect(selection).toEqual(ids);

    key({ key: 'Escape' });
    await screen.findByTestId('library-grid');
    expect(screen.queryByTestId('compare-view')).toBeNull();
    expect(store.getState().selection).toEqual(selection);
    expect(store.getState().library.view).toBe('grid');
  });

  it('leaves the zoom at Fit when it closes', async () => {
    await openLibrary(2);
    await userEvent.setup().keyboard('v');
    await screen.findByTestId('compare-view');
    key({ key: 'z', code: 'KeyZ' });
    expect(zoomStore.get().view.scale).toBe(1);
    key({ key: 'Escape' });
    await screen.findByTestId('library-grid');
    expect(zoomStore.get().view.scale).toBeNull();
  });

  it('closes when fewer than two of its photos are left', async () => {
    const { store, ids, fake } = await openLibrary(2);
    await userEvent.setup().keyboard('v');
    await screen.findByTestId('compare-view');
    act(() => fake.emit('photos:removed', { photoId: ids[1]! }));
    expect(screen.queryByTestId('compare-view')).toBeNull();
    expect(store.getState().library.view).toBe('grid');
  });
});

describe('delete in the compare view', () => {
  const deleteCalls = (fake: FakeBridge): PhotoId[][] =>
    fake.calls
      .filter((call) => call.channel === 'photos:delete')
      .map((call) => (call.args[0] as { photoIds: PhotoId[] }).photoIds);

  it('asks about the active pane only and keeps the other photos compared and selected', async () => {
    const { store, ids, fake } = await openLibrary(3);
    const user = userEvent.setup();
    await user.keyboard('v');
    await screen.findByTestId('compare-view');
    key({ key: 'ArrowLeft' });
    key({ key: 'ArrowLeft' });
    const losing = activeId() as PhotoId;
    expect(losing).toBe(ids[0]);

    await user.keyboard('{Delete}');
    const dialog = await screen.findByTestId('delete-photos-dialog');
    expect(dialog.textContent).toContain(photoOf(store, losing).fileName);
    expect(within(dialog).getByTestId('delete-photos-message').textContent).toMatch(/1 photo/);

    await user.click(within(dialog).getByTestId('delete-photos-confirm'));
    await waitFor(() => expect(paneIds()).toEqual([ids[1], ids[2]]));
    expect(deleteCalls(fake)).toEqual([[losing]]);
    expect(store.getState().library.view).toBe('compare');
    expect(store.getState().selection).toEqual([ids[1], ids[2]]);
    // The next pane took its place.
    expect(activeId()).toBe(ids[1]);
  });

  it('goes back to the grid when only one photo is left', async () => {
    const { store, ids } = await openLibrary(2);
    const user = userEvent.setup();
    await user.keyboard('v');
    await screen.findByTestId('compare-view');
    const losing = activeId();
    await user.keyboard('{Delete}');
    await user.click(await screen.findByTestId('delete-photos-confirm'));
    await screen.findByTestId('library-grid');
    expect(store.getState().library.view).toBe('grid');
    const left = ids.filter((id) => id !== losing);
    expect(store.getState().photos.some((photo) => photo.id === losing)).toBe(false);
    expect(left).toHaveLength(1);
    expect(store.getState().photos.some((photo) => photo.id === left[0])).toBe(true);
  });
});

describe('right-click in the compare view', () => {
  it('makes the pane active and puts the menu actions on its photo only', async () => {
    const { store, ids } = await openLibrary(3);
    const user = userEvent.setup();
    await user.keyboard('v');
    await screen.findByTestId('compare-view');
    expect(activeId()).toBe(ids[2]);
    const before = ids.map((id) => photoOf(store, id).rating);

    act(() => {
      fireEvent.contextMenu(panes()[0]!, { clientX: 100, clientY: 100 });
    });
    const menu = await screen.findByTestId('photo-menu');
    expect(activeId()).toBe(ids[0]);
    // The whole selection stays selected, the menu is about the one pane.
    expect(store.getState().selection).toEqual(ids);
    await user.click(within(menu).getByLabelText('Rate 4'));

    expect(photoOf(store, ids[0]!).rating).toBe(4);
    expect(ids.slice(1).map((id) => photoOf(store, id).rating)).toEqual(before.slice(1));
  });

  it('asks to delete the photo of the pane, not the selection', async () => {
    const { store, ids } = await openLibrary(3);
    await userEvent.setup().keyboard('v');
    await screen.findByTestId('compare-view');
    act(() => {
      fireEvent.contextMenu(panes()[1]!, { clientX: 100, clientY: 100 });
    });
    await userEvent.setup().click(await screen.findByTestId('photo-menu-delete'));
    await screen.findByTestId('delete-photos-dialog');
    expect(store.getState().deleteRequest?.photoIds).toEqual([ids[1]]);
  });
});

describe('rotating in the compare view', () => {
  const rotateCalls = (fake: FakeBridge): { photoIds: PhotoId[]; turns: number }[] =>
    fake.calls
      .filter((call) => call.channel === 'photos:rotate')
      .map((call) => call.args[0] as { photoIds: PhotoId[]; turns: number });

  it("turns the active pane's photo only, and plain arrows still move the active pane", async () => {
    const { store, ids, fake } = await openLibrary(3);
    await userEvent.setup().keyboard('v');
    await screen.findByTestId('compare-view');
    expect(activeId()).toBe(ids[2]);

    key({ key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(activeId()).toBe(ids[1]);
    expect(rotateCalls(fake)).toEqual([]);

    key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
    await waitFor(() => expect(rotateCalls(fake)).toHaveLength(1));
    expect(rotateCalls(fake)[0]).toEqual({ photoIds: [ids[1]], turns: 1 });
    await waitFor(() => expect(photoOf(store, ids[1]!).rotation).toBe(1));
    expect(ids.filter((id) => photoOf(store, id).rotation !== undefined)).toEqual([ids[1]]);
    // The turn did not move the active pane or change the selection.
    expect(activeId()).toBe(ids[1]);
    expect(store.getState().selection).toEqual(ids);

    key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true });
    await waitFor(() => expect(rotateCalls(fake)).toHaveLength(2));
    expect(rotateCalls(fake)[1]).toEqual({ photoIds: [ids[1]], turns: -1 });
  });

  it('turns the photo of the pane that was right-clicked from the menu', async () => {
    const { store, ids, fake } = await openLibrary(3);
    const user = userEvent.setup();
    await user.keyboard('v');
    await screen.findByTestId('compare-view');
    act(() => {
      fireEvent.contextMenu(panes()[0]!, { clientX: 100, clientY: 100 });
    });

    await user.click(await screen.findByTestId('photo-menu-rotate-left'));

    await waitFor(() => expect(rotateCalls(fake)).toHaveLength(1));
    expect(rotateCalls(fake)[0]).toEqual({ photoIds: [ids[0]], turns: -1 });
    expect(store.getState().photoMenu).toBeUndefined();
  });
});

describe('compare helpers', () => {
  it('orders the selection like the grid', () => {
    const grid = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] as { id: PhotoId }[];
    expect(compareOrder(['c', 'a', 'd'] as PhotoId[], grid)).toEqual(['a', 'c', 'd']);
    expect(compareOrder(['x', 'b'] as PhotoId[], grid)).toEqual(['b', 'x']);
  });

  it('moves the active pane and stops at the ends', () => {
    const ids = ['a', 'b', 'c'] as PhotoId[];
    expect(movedActive(ids, 'a' as PhotoId, -1)).toBe('a');
    expect(movedActive(ids, 'a' as PhotoId, 1)).toBe('b');
    expect(movedActive(ids, 'c' as PhotoId, 1)).toBe('c');
  });
});
