import type { PhotoId } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(autoAdvance: boolean): Promise<{ store: AppStore; fake: FakeBridge }> {
  const fake = createFakeBridge();
  await fake.bridge.invoke('settings:set', { autoAdvance });
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

const selected = (store: AppStore): string | undefined => store.getState().selectedId;
const order = (store: AppStore): PhotoId[] => store.getVisiblePhotos().map((photo) => photo.id);

describe('auto-advance', () => {
  it('stays on the photo when it is off', async () => {
    const { store } = await renderApp(false);
    const first = selected(store);
    await userEvent.setup().keyboard('3');
    expect(selected(store)).toBe(first);
  });

  it('moves to the next photo after tagging, rating or colouring in Develop', async () => {
    const { store } = await renderApp(true);
    const user = userEvent.setup();
    const ids = order(store);
    expect(store.getState().module).toBe('develop');
    expect(selected(store)).toBe(ids[0]);

    await user.keyboard('t');
    expect(selected(store)).toBe(ids[1]);
    expect(store.getState().photos.find((photo) => photo.id === ids[0])?.tagged).toBe(true);

    await user.keyboard('4');
    expect(selected(store)).toBe(ids[2]);
    expect(store.getState().photos.find((photo) => photo.id === ids[1])?.rating).toBe(4);

    await act(async () => {
      fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true });
    });
    expect(selected(store)).toBe(ids[3]);
    expect(store.getState().photos.find((photo) => photo.id === ids[2])?.colorClass).toBe(2);
  });

  it('stays on the last photo', async () => {
    const { store } = await renderApp(true);
    const ids = order(store);
    store.select(ids[ids.length - 1]!);
    await userEvent.setup().keyboard('5');
    expect(selected(store)).toBe(ids[ids.length - 1]);
    expect(store.getState().photos.find((photo) => photo.id === ids.at(-1))?.rating).toBe(5);
  });

  it('moves in the loupe, following the grid order', async () => {
    const { store } = await renderApp(true);
    const user = userEvent.setup();
    await user.keyboard('g');
    await screen.findByTestId('library-grid');
    const grid = store.getLibraryPhotos().map((photo) => photo.id);
    store.select(grid[0]!);
    await user.keyboard('e');
    await screen.findByTestId('library-loupe');
    await user.keyboard('t');
    expect(selected(store)).toBe(grid[1]);
  });

  it('does nothing in the grid', async () => {
    const { store } = await renderApp(true);
    const user = userEvent.setup();
    await user.keyboard('g');
    await screen.findByTestId('library-grid');
    const first = store.getLibraryPhotos()[0]!.id;
    store.select(first);
    await user.keyboard('t');
    await user.keyboard('3');
    expect(selected(store)).toBe(first);
  });

  it('does nothing for a multi-selection, in the loupe or the grid', async () => {
    const { store } = await renderApp(true);
    const user = userEvent.setup();
    await user.keyboard('g');
    await screen.findByTestId('library-grid');
    const grid = store.getLibraryPhotos().map((photo) => photo.id);
    store.select(grid[0]!);
    store.select(grid[2]!, 'range');
    await user.keyboard('e');
    await screen.findByTestId('library-loupe');
    expect(store.getState().selection.length).toBeGreaterThan(1);
    const active = selected(store);
    await user.keyboard('3');
    expect(selected(store)).toBe(active);
    expect(
      store
        .getState()
        .selection.every((id) => store.getState().photos.find((p) => p.id === id)?.rating === 3),
    ).toBe(true);
  });

  it('is turned on and off from the filter row, and saved in the settings', async () => {
    const { store, fake } = await renderApp(false);
    const user = userEvent.setup();
    const toggle = screen.getByTestId('auto-advance');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await waitFor(async () =>
      expect((await fake.bridge.invoke('settings:get')).autoAdvance).toBe(true),
    );
    expect(store.getState().settings?.autoAdvance).toBe(true);
    await user.click(toggle);
    await waitFor(async () =>
      expect((await fake.bridge.invoke('settings:get')).autoAdvance).toBe(false),
    );
  });
});
