import { asPhotoId, type Photo } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

beforeAll(() => {
  // jsdom has no pointer capture; the handle only needs it to exist.
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

async function renderApp(
  options: { lazyLibraryPhotos?: number; photos?: Photo[] } = {},
): Promise<{ store: AppStore; fake: FakeBridge }> {
  const fake = createFakeBridge({ photos: options.photos });
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    ...(options.lazyLibraryPhotos === undefined
      ? {}
      : { lazyLibraryPhotos: options.lazyLibraryPhotos }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  return { store, fake };
}

const handle = (): HTMLElement => screen.getByTestId('panel-resize-film-strip');
const heightOf = (): number => Number(handle().getAttribute('aria-valuenow'));
const maxHeight = (): number => Math.max(72, Math.min(480, Math.floor(window.innerHeight / 3)));

/** Enough photos to scroll: the virtualised strip never puts them all in the DOM. */
function manyPhotos(count: number): Photo[] {
  const base = mockPhotos();
  return Array.from({ length: count }, (_, index) => {
    const source = base[index % base.length]!;
    return {
      ...source,
      id: asPhotoId(`photo-${index}`),
      path: `/mock/photo-${index}.NEF`,
      sidecarPath: `/mock/photo-${index}.xmp`,
      fileName: `photo-${index}.NEF`,
    };
  });
}

describe('film strip resize handle', () => {
  it('is the shared horizontal handle on the strip top edge', async () => {
    await renderApp();
    expect(handle().getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle().getAttribute('data-side')).toBe('bottom');
    expect(heightOf()).toBe(92);
    expect(screen.getByTestId('film-strip-panel').style.height).toBe('92px');
  });

  it('follows a vertical drag live and saves the height when it ends', async () => {
    const { fake } = await renderApp();
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 420 });

    // The height follows the pointer before the button is released.
    expect(heightOf()).toBe(172);
    expect(screen.getByTestId('film-strip-panel').style.height).toBe('172px');
    expect(fake.settings.panelWidths?.['film-strip']).toBe(92);

    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 420 });
    await waitFor(() => expect(fake.settings.panelWidths?.['film-strip']).toBe(172));
  });

  it('resizes from the keyboard and clamps at the minimum and the window third', async () => {
    await renderApp();
    handle().focus();
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(heightOf()).toBe(100);
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(heightOf()).toBe(92);

    for (let index = 0; index < 80; index++) fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(heightOf()).toBe(maxHeight());

    for (let index = 0; index < 80; index++) fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(heightOf()).toBe(72);
  });

  it('resets to the default height on a double-click and drops the saved preference', async () => {
    const { fake } = await renderApp();
    handle().focus();
    for (let index = 0; index < 10; index++) fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(heightOf()).toBe(72);
    await waitFor(() => expect(fake.settings.panelWidths?.['film-strip']).toBe(72));

    fireEvent.doubleClick(handle());
    expect(heightOf()).toBe(92);
    await waitFor(() => expect(fake.settings.panelWidths?.['film-strip']).toBeUndefined());
  });

  it('restores a saved height', async () => {
    const fake = createFakeBridge();
    await fake.bridge.invoke('settings:set', { panelWidths: { 'film-strip': 140 } });
    window.eeTransport = fake.transport;
    const store = createAppStore(fake.bridge, {
      renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    });
    stores.push(store);
    render(<App store={store} />);
    await screen.findByTestId('film-strip');

    expect(heightOf()).toBe(140);
    expect(screen.getByTestId('film-strip-panel').style.height).toBe('140px');
  });

  it('shares one height between Develop and the Library loupe', async () => {
    const { store } = await renderApp();
    handle().focus();
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(heightOf()).toBe(108);

    act(() => store.openLibrary('loupe'));
    await screen.findByTestId('library-loupe');
    expect(heightOf()).toBe(108);

    handle().focus();
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(heightOf()).toBe(116);

    act(() => store.setModule('develop'));
    await screen.findByTestId('develop-view');
    expect(heightOf()).toBe(116);
  });

  it('keeps the open photo in view when taller thumbnails move it', async () => {
    const photos = manyPhotos(40);
    const { store } = await renderApp({ photos });
    const viewport = screen.getByTestId('film-strip');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    act(() => store.select(photos[20]!.id, 'replace'));
    await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
    const before = viewport.scrollLeft;

    handle().focus();
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(before));
  });

  it('resizes the virtualised strip with the lazy Library page too', async () => {
    const { store } = await renderApp({ lazyLibraryPhotos: 0 });
    await waitFor(() => expect(store.getState().lazy).toBe(true));
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));

    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 440 });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 440 });

    expect(heightOf()).toBe(152);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
});
