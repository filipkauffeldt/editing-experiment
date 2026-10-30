import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
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
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const thumbnail = (fileName: string): HTMLElement => {
  const button = document.querySelector<HTMLElement>(`button[title^="${fileName}"]`);
  if (!button) throw new Error(`no thumbnail for ${fileName}`);
  return button;
};

const cell = (fileName: string): HTMLElement => {
  const found = screen
    .getAllByTestId('library-cell')
    .find((element) => element.getAttribute('title')?.startsWith(fileName));
  if (!found) throw new Error(`no grid cell for ${fileName}`);
  return found;
};

describe('star ratings', () => {
  it('shows filled stars on the film strip, grid and inspector and nothing for 0', async () => {
    await renderApp();

    expect(within(thumbnail('_DSC8330.NEF')).getByTestId('rating-stars').textContent).toBe('★★★★★');
    expect(within(thumbnail('_DSC8331.NEF')).getByTitle('Rating 3 of 5')).toBeTruthy();
    expect(within(thumbnail('_DSC8332.NEF')).queryByTestId('rating-stars')).toBeNull();

    fireEvent.keyDown(window, { key: 'g' });
    await screen.findByTestId('library-grid');
    expect(within(cell('_DSC8330.NEF')).getByTitle('Rating 5 of 5')).toBeTruthy();
    expect(within(cell('_DSC8332.NEF')).queryByTestId('rating-stars')).toBeNull();

    fireEvent.click(cell('_DSC8331.NEF'));
    expect(
      within(screen.getByTestId('library-inspector')).getByTitle('Rating 3 of 5'),
    ).toBeTruthy();
  });
});
