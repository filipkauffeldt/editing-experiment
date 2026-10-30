import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import {
  cancelWbPicker,
  developViewStore,
  setBeforeAfter,
  setClipping,
  setWbPicker,
} from '../src/renderer/develop-view';
import { activePhoto, createAppStore, photoFlags, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(): Promise<{ store: AppStore; fake: FakeBridge }> {
  const fake = createFakeBridge();
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  return { store, fake };
}

function resetView(): void {
  setClipping(false, false);
  setBeforeAfter('off');
  setWbPicker(false);
  cancelWbPicker();
}

afterEach(async () => {
  resetView();
  for (const store of stores.splice(0)) await store.dispose();
});

const captionField = (): HTMLTextAreaElement => {
  const field = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
  if (!field) throw new Error('no caption field');
  return field;
};

const key = (init: KeyboardEventInit): void => {
  fireEvent.keyDown(window, init);
};

describe('develop shortcuts on non-US layouts', () => {
  it('uses printed letters and digits for before/after, clipping, white balance and classes', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');

    key({ key: 'y', code: 'KeyY' });
    expect(developViewStore.get().beforeAfter).toBe('before');
    key({ key: 'y', code: 'KeyY' });
    expect(developViewStore.get().beforeAfter).toBe('off');

    key({ key: 'j', code: 'KeyJ' });
    expect(developViewStore.get().clipShadows).toBe(true);
    expect(developViewStore.get().clipHighlights).toBe(true);
    key({ key: 'j', code: 'KeyJ' });
    expect(developViewStore.get().clipShadows).toBe(false);

    key({ key: 'w', code: 'KeyW' });
    expect(developViewStore.get().wbPicker).toBe(true);
    key({ key: 'Escape' });
    expect(developViewStore.get().wbPicker).toBe(false);

    key({ key: '7', code: 'Digit7' });
    expect(photoFlags(store.getState(), photo.id).colorClass).toBe(7);
  });

  it('keeps the optional physical backslash as a second before/after key', async () => {
    await renderApp();
    key({ key: '\\', code: 'Backslash' });
    expect(developViewStore.get().beforeAfter).toBe('before');
  });

  it('opens the shortcut list with F1 and Ctrl+/ by physical key, not a US symbol', async () => {
    const { store } = await renderApp();
    key({ key: 'F1', code: 'F1' });
    expect(store.getState().shortcutsOpen).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(store.getState().shortcutsOpen).toBe(false);

    fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true });
    expect(store.getState().shortcutsOpen).toBe(true);
    expect(screen.getByTestId('shortcuts-overlay').textContent).toContain('Y');
  });

  it('treats AltGr as a character, so it neither shortcuts nor resets the crop', async () => {
    const { store } = await renderApp();
    store.toggleCrop();
    store.setCropAngle(6);
    expect(store.getState().crop?.crop.angle).toBeCloseTo(6);

    // Swedish AltGr + `+` produces `\`, reported as a Ctrl+Alt combo.
    key({ key: '\\', code: 'Minus', ctrlKey: true, altKey: true });
    expect(store.getState().crop?.crop.angle).toBeCloseTo(6);
    expect(developViewStore.get().beforeAfter).toBe('off');
    expect(developViewStore.get().clipShadows).toBe(false);

    // A real Ctrl+Alt+R still resets the crop.
    key({ key: 'r', code: 'KeyR', ctrlKey: true, altKey: true });
    expect(store.getState().crop?.crop.angle).toBe(0);
  });

  it('lets å, ä, ö and dead keys type without firing shortcuts', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const user = userEvent.setup();
    const caption = captionField();
    caption.focus();
    await user.type(caption, 'åäö yjw7');
    expect(caption.value).toContain('åäö');
    expect(developViewStore.get().beforeAfter).toBe('off');
    expect(developViewStore.get().clipShadows).toBe(false);
    expect(developViewStore.get().wbPicker).toBe(false);
    expect(photoFlags(store.getState(), photo.id).colorClass).toBe(0);

    // A dead key (¨) followed by u must not toggle anything either.
    fireEvent.keyDown(caption, { key: 'Dead', code: 'Quote' });
    fireEvent.keyDown(caption, { key: 'u', code: 'KeyU' });
    expect(developViewStore.get().beforeAfter).toBe('off');
    expect(photoFlags(store.getState(), photo.id).tagged).toBe(false);
  });
});

describe('before/after never writes parameters', () => {
  it('does not save anything when showing before with Y', async () => {
    const { fake } = await renderApp();
    const before = fake.calls.filter((call) => call.channel === 'develop:setParams').length;
    key({ key: 'y', code: 'KeyY' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fake.calls.filter((call) => call.channel === 'develop:setParams')).toHaveLength(before);
  });
});
