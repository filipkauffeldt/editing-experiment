import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
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

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const started = (fake: FakeBridge) =>
  fake.calls.filter((call) => call.channel === 'export:start').length;

describe('Next & send shortcut and button', () => {
  it('ignores a held Ctrl+Enter, and sends again on a new press', async () => {
    const { store, fake } = await renderApp();
    const first = activePhoto(store.getState())?.id;

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(started(fake)).toBe(1));
    const second = activePhoto(store.getState())?.id;
    expect(second).not.toBe(first);

    for (let repeat = 0; repeat < 5; repeat++) {
      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, repeat: true });
    }
    expect(started(fake)).toBe(1);
    expect(activePhoto(store.getState())?.id).toBe(second);

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(started(fake)).toBe(2));
  });

  it('keeps the button usable while an export is running', async () => {
    const { store, fake } = await renderApp();
    const button = await screen.findByTestId('next-send');

    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await vi.waitFor(() => expect(started(fake)).toBe(2));
    expect(activePhoto(store.getState())?.fileName).toBe('_DSC8332.NEF');
  });
});
