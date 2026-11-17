import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import {
  activeDevelopVersion,
  activePhoto,
  createAppStore,
  editParamsKey,
  type AppStore,
} from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(): Promise<AppStore> {
  const fake = createFakeBridge();
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  await vi.waitFor(() => expect(activePhoto(store.getState())).toBeDefined());
  const photo = activePhoto(store.getState())!;
  await vi.waitFor(() =>
    expect(
      store.getState().editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)],
    ).toBeDefined(),
  );
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const press = (init: KeyboardEventInit, target: Window | Element = window): void => {
  act(() => {
    fireEvent.keyDown(target, init);
  });
};
const undoKey = { key: 'z', ctrlKey: true } as const;
const redoKey = { key: 'Z', ctrlKey: true, shiftKey: true } as const;

const ratingOf = (store: AppStore): number | undefined => {
  const open = activePhoto(store.getState());
  return store.getState().photos.find((photo) => photo.id === open?.id)?.rating;
};
const exposure = (store: AppStore): number | undefined => {
  const photo = activePhoto(store.getState())!;
  return store.getState().editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)]
    ?.Exposure2012;
};

describe('Ctrl/Cmd+Z across labels and develop', () => {
  it('undoes the newest of a rating and a develop step, and redoes in the opposite order', async () => {
    const store = await renderApp();
    expect(store.getState().module).toBe('develop');
    const original = ratingOf(store)!;
    const changed = original === 4 ? 2 : 4;
    store.setSlider('Exposure2012', 0.5);
    store.setRating(changed);
    expect(exposure(store)).toBe(0.5);
    expect(ratingOf(store)).toBe(changed);

    press(undoKey);
    await vi.waitFor(() => expect(ratingOf(store)).toBe(original));
    expect(exposure(store)).toBe(0.5);
    await screen.findByText(/^Undid rating on /);

    press(undoKey);
    expect(exposure(store)).toBeUndefined();

    // Redo takes back the newest undo first: the develop step, then the rating.
    press({ key: 'y', ctrlKey: true });
    expect(exposure(store)).toBe(0.5);
    expect(ratingOf(store)).toBe(original);
    press(redoKey);
    await vi.waitFor(() => expect(ratingOf(store)).toBe(changed));
    await screen.findByText(/^Redid rating on /);
  });

  it('undoes labels in the Library and leaves the develop history alone', async () => {
    const store = await renderApp();
    store.setSlider('Exposure2012', 0.25);
    store.setModule('library');
    store.setColorClass(3);

    press(undoKey);
    await vi.waitFor(() =>
      expect(store.getState().toasts.at(-1)?.message).toMatch(/^Undid colour/),
    );
    // Nothing else to undo in the Library: the develop step is not taken.
    press(undoKey);
    expect(exposure(store)).toBe(0.25);
    expect(store.getState().toasts).toHaveLength(1);
  });

  it('leaves Ctrl/Cmd+Z to the field while a caption is being edited', async () => {
    const store = await renderApp();
    const original = ratingOf(store)!;
    const changed = original === 2 ? 3 : 2;
    store.setRating(changed);
    const field = document.querySelector<HTMLTextAreaElement>('[data-caption-input]')!;
    field.focus();

    press(undoKey, field);
    expect(ratingOf(store)).toBe(changed);
    // The same press outside the field takes the rating back.
    field.blur();
    press(undoKey);
    await vi.waitFor(() => expect(ratingOf(store)).toBe(original));
  });

  it('does not treat Ctrl+Alt+Z (AltGr on Windows and Linux) as undo', async () => {
    const store = await renderApp();
    const changed = ratingOf(store) === 2 ? 3 : 2;
    store.setRating(changed);
    press({ key: 'z', ctrlKey: true, altKey: true });
    press({ key: 'z', ctrlKey: true, altKey: true, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ratingOf(store)).toBe(changed);
  });
  it('records only the active pane’s photo in the compare view and takes it back alone', async () => {
    const store = await renderApp();
    store.setModule('library');
    const [first, second, third] = store.getState().photos.map((photo) => photo.id);
    store.select(first);
    store.select(second, 'toggle');
    store.select(third, 'toggle');
    store.openCompare();
    expect(store.getState().library.view).toBe('compare');
    store.setCompareActive(second!);
    const ratingFor = (id: typeof first) =>
      store.getState().photos.find((photo) => photo.id === id)?.rating;
    const before = [first, second, third].map(ratingFor);
    const changed = before[1] === 4 ? 2 : 4;

    press({ key: String(changed) });
    expect([first, second, third].map(ratingFor)).toEqual([before[0], changed, before[2]]);

    press(undoKey);
    await vi.waitFor(() => expect(ratingFor(second)).toBe(before[1]));
    expect([first, second, third].map(ratingFor)).toEqual(before);
    await screen.findByText(/^Undid rating on /);

    press(redoKey);
    await vi.waitFor(() => expect(ratingFor(second)).toBe(changed));
    expect([ratingFor(first), ratingFor(third)]).toEqual([before[0], before[2]]);
  });
});
