import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { activePhoto, createAppStore, photoFlags, type AppStore } from '../src/renderer/store';
import { FIT_VIEW } from '../src/renderer/view-transform';
import { setPanHeld, zoomKey, zoomStore } from '../src/renderer/zoom-view';
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
  await screen.findByTestId('photo-canvas');
  return store;
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

const scale = (): number | null => zoomStore.get().view.scale;

describe('zoom keys in the app', () => {
  it('Z zooms to the chosen level and back to Fit', async () => {
    const store = await renderApp();
    const photo = activePhoto(store.getState());
    expect(photo).toBeDefined();
    expect(scale()).toBeNull();
    key({ key: 'z', code: 'KeyZ' });
    expect(scale()).toBe(1);
    expect(zoomStore.get().key).toBe(zoomKey(photo!.id, 'develop'));
    key({ key: 'z', code: 'KeyZ' });
    expect(scale()).toBeNull();
  });

  it('ignores a held Z, so a long press does not flicker between Fit and zoomed', async () => {
    await renderApp();
    key({ key: 'z', code: 'KeyZ', repeat: true });
    expect(scale()).toBeNull();
  });

  it('Ctrl + and - zoom in steps without Shift on a Swedish keyboard', async () => {
    await renderApp();
    key({ key: '+', code: 'Minus', ctrlKey: true });
    const first = scale();
    expect(first).not.toBeNull();
    key({ key: '+', code: 'NumpadAdd', ctrlKey: true });
    expect(scale()! / first!).toBeCloseTo(1.25, 6);
    key({ key: '=', code: 'Equal', ctrlKey: true });
    expect(scale()! / first!).toBeCloseTo(1.5625, 6);
    key({ key: '-', code: 'Slash', ctrlKey: true });
    key({ key: '-', code: 'NumpadSubtract', ctrlKey: true });
    expect(scale()! / first!).toBeCloseTo(1, 6);
  });

  it('Ctrl+- zooms out and does not open the shortcut list, even though it sits on the Slash key', async () => {
    const store = await renderApp();
    key({ key: '+', code: 'Minus', ctrlKey: true });
    key({ key: '-', code: 'Slash', ctrlKey: true });
    expect(store.getState().shortcutsOpen).toBe(false);
  });

  it('never zooms for AltGr, which types a character', async () => {
    await renderApp();
    key({ key: '\\', code: 'Minus', ctrlKey: true, altKey: true });
    key({ key: '+', code: 'Minus', ctrlKey: true, altKey: true });
    key({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true });
    expect(scale()).toBeNull();
    // A driver that reports AltGraph rather than Ctrl+Alt.
    act(() => {
      fireEvent.keyDown(window, { key: '+', code: 'Minus', modifierAltGraph: true });
    });
    expect(scale()).toBeNull();
  });

  it('does not zoom for å, ä, ö or a dead key', async () => {
    await renderApp();
    for (const name of ['å', 'ä', 'ö', 'Dead']) key({ key: name, code: 'Quote' });
    expect(scale()).toBeNull();
  });

  it('leaves Ctrl+0 to the colour class and does not zoom', async () => {
    const store = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    key({ key: '3', code: 'Digit3', ctrlKey: true });
    expect(photoFlags(store.getState(), photo.id).colorClass).toBe(3);
    key({ key: '0', code: 'Digit0', ctrlKey: true });
    expect(photoFlags(store.getState(), photo.id).colorClass).toBe(0);
    expect(scale()).toBeNull();
  });

  it('types a Z into a text field instead of zooming', async () => {
    await renderApp();
    const field = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
    if (!field) throw new Error('no caption field');
    field.focus();
    act(() => {
      fireEvent.keyDown(field, { key: 'z', code: 'KeyZ' });
      fireEvent.keyDown(field, { key: '+', code: 'Minus', ctrlKey: true });
    });
    expect(scale()).toBeNull();
  });

  it('only zooms in Develop', async () => {
    const store = await renderApp();
    store.openLibrary('grid');
    key({ key: 'z', code: 'KeyZ' });
    key({ key: '+', code: 'Minus', ctrlKey: true });
    expect(scale()).toBeNull();
  });
});

describe('Space pan key', () => {
  const space = (type: 'keyDown' | 'keyUp', target: Element | Window = window): void => {
    act(() => {
      fireEvent[type](target, { key: ' ', code: 'Space' });
    });
  };

  it('holds the pan state while Space is down and releases it on key up', async () => {
    await renderApp();
    space('keyDown');
    expect(zoomStore.get().panHeld).toBe(true);
    expect(screen.queryByTestId('pan-layer')).not.toBeNull();
    space('keyUp');
    expect(zoomStore.get().panHeld).toBe(false);
    expect(screen.queryByTestId('pan-layer')).toBeNull();
  });

  it('is released when the window loses focus', async () => {
    await renderApp();
    space('keyDown');
    act(() => {
      fireEvent.blur(window);
    });
    expect(zoomStore.get().panHeld).toBe(false);
  });

  it('is ignored in a text field, which keeps its space', async () => {
    await renderApp();
    const field = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
    if (!field) throw new Error('no caption field');
    field.focus();
    const proceeded = fireEvent.keyDown(field, { key: ' ', code: 'Space' });
    expect(proceeded).toBe(true);
    expect(zoomStore.get().panHeld).toBe(false);
  });

  it('cancels its own default (a focused button would click), but not a typed space', async () => {
    await renderApp();
    const proceeded = fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(proceeded).toBe(false);
    const upProceeded = fireEvent.keyUp(window, { key: ' ', code: 'Space' });
    expect(upProceeded).toBe(false);
  });

  it('does not pan with Ctrl+Space (the caption expander) or in the Library', async () => {
    const store = await renderApp();
    act(() => {
      fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true });
    });
    expect(zoomStore.get().panHeld).toBe(false);
    store.openLibrary('grid');
    space('keyDown');
    expect(zoomStore.get().panHeld).toBe(false);
  });
});
