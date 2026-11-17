import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Photo } from '@ee/contracts';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderLoupe(photos: Photo[] = mockPhotos()): Promise<AppStore> {
  const fake = createFakeBridge({ photos });
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  act(() => store.select(photos[0]!.id));
  act(() => store.openLibrary('loupe'));
  await screen.findByTestId('library-loupe');
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

describe('shooting information in the Library loupe', () => {
  it('shows the shooting fields and the camera body on one line', async () => {
    await renderLoupe();
    expect(screen.getByTestId('loupe-shooting-info').textContent).toBe(
      'ISO 3200 · 135mm · f/2.8 · 1/1000s · NIKON Z 9',
    );
  });

  it('hides the line when Tab hides the panels', async () => {
    await renderLoupe();
    expect(screen.queryByTestId('loupe-shooting-info')).not.toBeNull();

    fireEvent.keyDown(window, { key: 'Tab' });
    expect(screen.queryByTestId('loupe-shooting-info')).toBeNull();

    fireEvent.keyDown(window, { key: 'Tab' });
    expect(screen.queryByTestId('loupe-shooting-info')).not.toBeNull();
  });

  it('shows no line for a photo without shooting information', async () => {
    const [first] = mockPhotos();
    await renderLoupe([{ ...first!, camera: undefined }]);
    expect(screen.queryByTestId('loupe-shooting-info')).toBeNull();
  });
});
