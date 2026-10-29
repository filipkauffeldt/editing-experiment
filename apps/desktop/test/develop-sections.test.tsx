import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, paramsForPhoto, activePhoto, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(defaults: Record<string, number> = {}): Promise<AppStore> {
  const fake = createFakeBridge({ handlers: { 'develop:getDefaults': async () => defaults } });
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

const params = (store: AppStore) => paramsForPhoto(store.getState(), activePhoto(store.getState()));

describe('develop section switches', () => {
  it('parks a section on switch off and restores its values on switch on', async () => {
    const store = await renderApp();
    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    store.setSlider('Exposure2012', 0.8);
    store.setSlider('Contrast2012', 25);
    expect(params(store).Exposure2012).toBe(0.8);

    const toneSwitch = screen.getByRole('switch', { name: 'Tone on or off' });
    fireEvent.click(toneSwitch);
    expect(toneSwitch.getAttribute('aria-checked')).toBe('false');
    expect(params(store).Exposure2012).toBeUndefined();
    expect(params(store).Contrast2012).toBeUndefined();

    fireEvent.click(toneSwitch);
    expect(toneSwitch.getAttribute('aria-checked')).toBe('true');
    expect(params(store).Exposure2012).toBe(0.8);
    expect(params(store).Contrast2012).toBe(25);
  });

  it('writes the neutral value for a raw default while a section is off, and drops it on', async () => {
    const store = await renderApp({ Sharpness: 40 });
    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    await waitFor(() => expect(params(store).Sharpness).toBe(40));

    const detail = screen.getByRole('switch', { name: 'Detail on or off' });
    fireEvent.click(detail);
    // The raw default would otherwise come straight back.
    expect(params(store).Sharpness).toBe(0);

    fireEvent.click(detail);
    expect(params(store).Sharpness).toBe(40);
  });
});
