import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const keywordsField = (root: ParentNode = document): HTMLInputElement => {
  const field = root.querySelector<HTMLInputElement>('[data-keywords-input]');
  if (!field) throw new Error('no keywords field');
  return field;
};

const key = (init: KeyboardEventInit): void => {
  fireEvent.keyDown(window, init);
};

describe('develop shortcuts on non-US layouts', () => {
  it('uses printed letters and digits for before/after, clipping, white balance, ratings and classes', async () => {
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

    key({ key: '4', code: 'Digit4' });
    expect(photoFlags(store.getState(), photo.id).rating).toBe(4);
    key({ key: '5', code: 'Numpad5' });
    expect(photoFlags(store.getState(), photo.id).rating).toBe(5);
    key({ key: '0', code: 'Digit0' });
    expect(photoFlags(store.getState(), photo.id).rating).toBe(0);

    key({ key: '7', code: 'Digit7' });
    expect(photoFlags(store.getState(), photo.id).colorClass).toBe(0);
    key({ key: '7', code: 'Digit7', ctrlKey: true });
    expect(photoFlags(store.getState(), photo.id).colorClass).toBe(7);
    key({ key: '0', code: 'Digit0', ctrlKey: true });
    expect(photoFlags(store.getState(), photo.id).colorClass).toBe(0);
  });

  it('does not take Shift+digit symbols or AltGr as ratings or colour classes', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const before = photoFlags(store.getState(), photo.id);

    key({ key: '!', code: 'Digit1', shiftKey: true });
    key({ key: '¤', code: 'Digit4', shiftKey: true });
    key({ key: '#', code: 'Digit3', shiftKey: true });
    expect(photoFlags(store.getState(), photo.id)).toEqual(before);

    key({ key: '7', code: 'Digit7', ctrlKey: true, altKey: true });
    key({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true });
    expect(photoFlags(store.getState(), photo.id)).toEqual(before);
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
    const before = photoFlags(store.getState(), photo.id);
    const user = userEvent.setup();
    const caption = captionField();
    caption.focus();
    await user.type(caption, 'åäö yjw7');
    fireEvent.keyDown(caption, { key: '2', code: 'Digit2', ctrlKey: true });
    expect(caption.value).toContain('åäö');
    expect(developViewStore.get().beforeAfter).toBe('off');
    expect(developViewStore.get().clipShadows).toBe(false);
    expect(developViewStore.get().wbPicker).toBe(false);
    expect(photoFlags(store.getState(), photo.id)).toEqual(before);

    // A dead key (¨) followed by u must not toggle anything either.
    fireEvent.keyDown(caption, { key: 'Dead', code: 'Quote' });
    fireEvent.keyDown(caption, { key: 'u', code: 'KeyU' });
    expect(developViewStore.get().beforeAfter).toBe('off');
    expect(photoFlags(store.getState(), photo.id).tagged).toBe(false);
  });
});

describe('keywords shortcut', () => {
  it('focuses the keywords draft at the end, from inside the caption field', async () => {
    await renderApp();
    const keywords = keywordsField();
    const scrollIntoView = vi.fn();
    Object.assign(keywords, { scrollIntoView });
    const caption = captionField();
    caption.focus();

    key({ key: 'k', ctrlKey: true });

    expect(document.activeElement).toBe(keywords);
    expect(keywords.selectionStart).toBe(keywords.value.length);
    expect(keywords.selectionEnd).toBe(keywords.value.length);
    expect(keywords.value.slice(keywords.selectionStart ?? 0, keywords.selectionEnd ?? 0)).toBe('');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('keeps an unfinished draft and puts the caret after it', async () => {
    await renderApp();
    const user = userEvent.setup();
    const keywords = keywordsField();
    await user.click(keywords);
    await user.type(keywords, 'portrait');
    keywords.setSelectionRange(0, 3);

    // Caps Lock reports an upper-case `K`; it must work like the lower-case key.
    fireEvent.keyDown(keywords, { key: 'K', ctrlKey: true });

    expect(document.activeElement).toBe(keywords);
    expect(keywords.value).toBe('portrait');
    expect(keywords.selectionStart).toBe(8);
    expect(keywords.selectionEnd).toBe(8);
    expect(keywords.value.slice(keywords.selectionStart ?? 0, keywords.selectionEnd ?? 0)).toBe('');
  });

  it('opens the Library batch dialog at Keywords and scrolls to it', async () => {
    const { store } = await renderApp();
    store.openLibrary('loupe');
    await waitFor(() => expect(store.getState().module).toBe('library'));

    const original = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      key({ key: 'k', ctrlKey: true });

      const dialog = screen.getByTestId('batch-caption-dialog');
      const keywords = keywordsField(dialog);
      expect(document.activeElement).toBe(keywords);
      expect(keywords.value).toBe('');
      expect(keywords.selectionStart).toBe(0);
      expect(keywords.selectionEnd).toBe(0);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      if (original) HTMLElement.prototype.scrollIntoView = original;
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('does not fire for AltGr or behind a dialog', async () => {
    const { store } = await renderApp();
    const keywords = keywordsField();

    const altGraph = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
    });
    Object.defineProperty(altGraph, 'getModifierState', { value: () => true });
    fireEvent(window, altGraph);
    expect(document.activeElement).not.toBe(keywords);

    // A real Ctrl+K still works.
    key({ key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(keywords);
    keywords.blur();

    // But not while a dialog owns the keyboard.
    key({ key: 'F1' });
    expect(store.getState().shortcutsOpen).toBe(true);
    key({ key: 'k', ctrlKey: true });
    expect(document.activeElement).not.toBe(keywords);
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
