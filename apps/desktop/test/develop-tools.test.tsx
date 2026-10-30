import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import {
  cancelWbPicker,
  clearHistogram,
  developViewStore,
  setBeforeAfter,
  setClipping,
  setHistogram,
  setWbPicker,
} from '../src/renderer/develop-view';
import { activePhoto, createAppStore, type AppStore } from '../src/renderer/store';
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
  clearHistogram();
  setBeforeAfter('off');
  setWbPicker(false);
  cancelWbPicker();
}

afterEach(async () => {
  resetView();
  for (const store of stores.splice(0)) await store.dispose();
});

describe('histogram and clipping switches', () => {
  it('shows the EXIF line and toggles each clipping side', async () => {
    await renderApp();
    expect(screen.getByTestId('histogram')).toBeTruthy();
    const exif = screen.getByTestId('histogram-exif').textContent ?? '';
    expect(exif).toContain('ISO 3200');
    expect(exif).toContain('135mm');
    expect(exif).toContain('f/2.8');
    expect(exif).toContain('1/1000s');

    fireEvent.click(screen.getByTestId('clip-shadows'));
    expect(developViewStore.get().clipShadows).toBe(true);
    expect(developViewStore.get().clipHighlights).toBe(false);
    expect(screen.getByTestId('clip-shadows').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('clip-highlights'));
    expect(developViewStore.get().clipHighlights).toBe(true);
  });
});

it('draws the histogram faintly behind the tone curve', async () => {
  const { store } = await renderApp();
  const photo = activePhoto(store.getState());
  if (!photo) throw new Error('no selection');
  const bins = new Uint32Array(256);
  bins[40] = 500;
  bins[128] = 900;
  setHistogram(photo.id, {
    bins: 256,
    red: bins,
    green: bins,
    blue: bins,
    luminance: bins,
  });
  const curve = await screen.findByTestId('tone-curve');
  await waitFor(() =>
    expect(curve.querySelector('[data-testid="tone-curve-histogram"]')).not.toBeNull(),
  );
});

describe('before/after and Auto write the right things', () => {
  it('shows before without touching the develop parameters', async () => {
    const { fake } = await renderApp();
    const before = fake.calls.filter((call) => call.channel === 'develop:setParams').length;
    fireEvent.click(screen.getByTestId('before-after'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fake.calls.filter((call) => call.channel === 'develop:setParams')).toHaveLength(before);
  });

  it('saves Auto tone and Auto WB as normal parameters through develop:setParams', async () => {
    const { store, fake } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');

    store.applyAutoTone({
      Exposure2012: 0.7,
      Contrast2012: 6,
      Highlights2012: -40,
      Shadows2012: 25,
      Whites2012: 12,
      Blacks2012: -18,
      Vibrance: 15,
      Saturation: 3,
    });
    await waitFor(() => {
      const call = fake.calls.findLast((candidate) => candidate.channel === 'develop:setParams');
      expect(call).toBeDefined();
      expect(call?.args[0]).toMatchObject({
        photoId: photo.id,
        params: {
          Exposure2012: 0.7,
          Highlights2012: -40,
          Shadows2012: 25,
          Vibrance: 15,
        },
      });
    });

    store.setWhiteBalance(4200, 9);
    await waitFor(() => {
      const call = fake.calls.findLast((candidate) => candidate.channel === 'develop:setParams');
      expect(call?.args[0]).toMatchObject({
        params: { WhiteBalance: 'Custom', Temperature: 4200, Tint: 9 },
      });
    });
  });
});
