import { asPhotoId } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, panelsAreHidden, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(): Promise<{ store: AppStore; fake: FakeBridge }> {
  const fake = createFakeBridge();
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    confirm: () => true,
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  return { store, fake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const tab = (target: Window | Element = window, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(target, { key: 'Tab', ...init });
};
const developHidden = (): boolean => screen.getByTestId('develop-view').dataset.panels === 'hidden';
const stripsHidden = (): boolean => screen.getByTestId('develop-strips').hasAttribute('hidden');

describe('Tab hides and shows the panels', () => {
  it('toggles the side panels, the filter row and the film strip in Develop', async () => {
    const { store } = await renderApp();
    expect(developHidden()).toBe(false);

    tab();
    expect(developHidden()).toBe(true);
    expect(screen.getByTestId('develop-left-panels').hasAttribute('hidden')).toBe(true);
    expect(screen.getByTestId('develop-right-panels').hasAttribute('hidden')).toBe(true);
    expect(stripsHidden()).toBe(true);
    expect(screen.getByTestId('develop-view').style.gridTemplateColumns).toBe(
      '0px minmax(0, 1fr) 0px',
    );

    tab();
    expect(developHidden()).toBe(false);
    expect(stripsHidden()).toBe(false);
    expect(panelsAreHidden(store.getState())).toBe(false);
  });

  it('hides the sidebar and the inspector in the Library, and the state carries between views', async () => {
    const { store } = await renderApp();
    act(() => store.openLibrary('grid'));
    await screen.findByTestId('library-view');
    tab();
    expect(screen.getByTestId('library-view').dataset.panels).toBe('hidden');
    expect(screen.getByTestId('library-left-panels').hasAttribute('hidden')).toBe(true);
    expect(screen.getByTestId('library-right-panels').hasAttribute('hidden')).toBe(true);

    act(() => store.setModule('develop'));
    expect(developHidden()).toBe(true);
    tab();
    expect(developHidden()).toBe(false);
  });

  it('keeps Tab for the focus in a text field and a dialog, and Shift+Tab is not a toggle', async () => {
    const { store } = await renderApp();
    const caption = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
    if (!caption) throw new Error('no caption field');
    caption.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    caption.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(developHidden()).toBe(false);
    caption.blur();

    tab(window, { shiftKey: true });
    expect(developHidden()).toBe(false);

    act(() => store.toggleShortcuts(true));
    tab();
    expect(developHidden()).toBe(false);
    act(() => store.toggleShortcuts(false));

    // Plain Tab with nothing in the way is taken, so the browser does not also move the focus.
    const plain = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(true);
    expect(developHidden()).toBe(true);
  });
});

describe('Retouch and Crop hide the panels while open', () => {
  it('opens Retouch with the panels hidden, Tab brings them back, and leaving restores the view', async () => {
    const { store } = await renderApp();
    expect(developHidden()).toBe(false);

    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByTestId('retouch-toolbar');
    expect(developHidden()).toBe(true);
    expect(stripsHidden()).toBe(true);

    tab();
    expect(developHidden()).toBe(false);
    expect(stripsHidden()).toBe(false);

    fireEvent.click(screen.getByTestId('done-retouch'));
    await waitFor(() => expect(store.getState().retouch).toBeUndefined());
    expect(developHidden()).toBe(false);

    // The next session starts hidden again, even after Tab showed the panels in the last one.
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByTestId('retouch-toolbar');
    expect(developHidden()).toBe(true);
    tab();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(store.getState().retouch).toBeUndefined());
  });

  it('puts back a hidden view after Crop, and opens Crop hidden from a shown one', async () => {
    const { store } = await renderApp();
    tab();
    expect(developHidden()).toBe(true);

    fireEvent.keyDown(window, { key: 'c' });
    await screen.findByTestId('crop-toolbar');
    expect(developHidden()).toBe(true);
    tab();
    expect(developHidden()).toBe(false);
    tab();
    expect(developHidden()).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(store.getState().crop).toBeUndefined());
    expect(developHidden()).toBe(true);

    tab();
    expect(developHidden()).toBe(false);
    fireEvent.keyDown(window, { key: 'c' });
    await screen.findByTestId('crop-toolbar');
    expect(developHidden()).toBe(true);
    fireEvent.click(screen.getByTestId('apply-crop'));
    await waitFor(() => expect(store.getState().crop).toBeUndefined());
    expect(developHidden()).toBe(false);
  });

  it('writes a caption edit that is still waiting for its save when Retouch hides the panel', async () => {
    const { store, fake } = await renderApp();
    const photoId = asPhotoId('mock-01');
    await waitFor(() => expect(store.getState().metadata[photoId]).toBeDefined());
    const caption = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
    if (!caption) throw new Error('no caption field');
    fireEvent.change(caption, { target: { value: 'Header in the box' } });
    const writes = (): number =>
      fake.calls.filter((call) => call.channel === 'metadata:write').length;
    const before = writes();

    // Well inside the 500 ms debounce.
    fireEvent.click(screen.getByTestId('toggle-retouch'));
    await screen.findByTestId('retouch-toolbar');

    await waitFor(() => expect(writes()).toBe(before + 1));
    const call = fake.calls.filter((candidate) => candidate.channel === 'metadata:write').at(-1);
    expect(JSON.stringify(call?.args)).toContain('Header in the box');
    expect(store.getState().metadata[photoId]?.caption).toBe('Header in the box');
  });
});
