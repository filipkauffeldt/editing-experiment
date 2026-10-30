import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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

const thumbnail = (fileName: string): HTMLElement => {
  const button = document.querySelector<HTMLElement>(`button[title^="${fileName}"]`);
  if (!button) throw new Error(`no thumbnail for ${fileName}`);
  return button;
};

const applyCalls = (fake: FakeBridge) =>
  fake.calls.filter((call) => call.channel === 'develop:applySettings');

function altGraphKeyDown(init: KeyboardEventInit): void {
  const event = new KeyboardEvent('keydown', init);
  Object.defineProperty(event, 'getModifierState', {
    value: (key: string) => key === 'AltGraph',
  });
  act(() => window.dispatchEvent(event));
}

describe('copy and paste develop settings', () => {
  it('opens Copy Settings with every group but Crop checked', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'C', ctrlKey: true, shiftKey: true });
    await screen.findByTestId('copy-settings-dialog');

    expect((screen.getByTestId('copy-group-whiteBalance') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('copy-group-basicTone') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('copy-group-detail') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('copy-group-crop') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('copy-settings-dialog').textContent).toContain(
      'Retouch is never copied',
    );
  });

  it('copies the active photo and pastes the chosen groups onto three photos', async () => {
    const { store, fake } = await renderApp();
    // Photo 3 is edited and retouched, so its settings are worth copying.
    fireEvent.click(thumbnail('_DSC8332.NEF'));
    fireEvent.keyDown(window, { key: 'C', ctrlKey: true, shiftKey: true });
    await screen.findByTestId('copy-settings-dialog');
    fireEvent.click(screen.getByTestId('copy-settings-confirm'));
    await waitFor(() => expect(store.getState().copiedSettings).toBeDefined());
    expect(store.getState().copySettings).toBeUndefined();

    fireEvent.click(thumbnail('_DSC8333.NEF'));
    fireEvent.click(thumbnail('_DSC8335.NEF'), { shiftKey: true });
    const targets = [...store.getState().selection];
    expect(targets).toHaveLength(3);

    fireEvent.keyDown(window, { key: 'V', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(applyCalls(fake)).toHaveLength(1));
    const args = applyCalls(fake)[0]!.args[0] as {
      photoIds: string[];
      groups: string[];
      params: Record<string, unknown>;
    };
    expect(args.photoIds).toEqual(targets);
    expect(args.groups).not.toContain('crop');
    expect(args.params).toMatchObject({ Exposure2012: 0.45, Contrast2012: 18 });

    for (const photoId of targets) {
      const photo = store.getState().photos.find((candidate) => candidate.id === photoId);
      const versionId = photo?.versions.find((version) => version.kind === 'develop')?.id;
      const params = await fake.bridge.invoke('develop:getParams', {
        photoId: photoId as never,
        versionId,
      });
      expect(params).toMatchObject({ Exposure2012: 0.45, Contrast2012: 18 });
      expect(params.crop).toBeUndefined();
    }
    // Retouch ops stay with the source photo; the paste never writes them.
    expect(fake.calls.some((call) => call.channel === 'retouch:set')).toBe(false);
  });

  it('syncs the active photo to the Library selection through the same dialog', async () => {
    const { store, fake } = await renderApp();
    fireEvent.keyDown(window, { key: 'g' });
    await screen.findByTestId('library-grid');
    const cells = document.querySelectorAll<HTMLElement>('[data-testid="library-cell"]');
    fireEvent.click(cells[0]!);
    fireEvent.click(cells[2]!, { shiftKey: true });
    expect(store.getState().selection).toHaveLength(3);

    fireEvent.click(screen.getByTestId('sync-settings'));
    await screen.findByTestId('copy-settings-dialog');
    expect(screen.getByTestId('copy-settings-dialog').textContent).toContain('Sync Settings');
    fireEvent.click(screen.getByTestId('copy-settings-confirm'));
    await waitFor(() => expect(applyCalls(fake)).toHaveLength(1));
    expect((applyCalls(fake)[0]!.args[0] as { photoIds: string[] }).photoIds).toHaveLength(3);
  });

  it('pastes the previously edited photo with Ctrl+Alt+V, but not with AltGr', async () => {
    const { store, fake } = await renderApp();
    const first = activePhoto(store.getState());
    if (!first) throw new Error('no selection');
    store.setSlider('Exposure2012', 1.25);
    store.select(store.getState().photos[1]!.id);
    await waitFor(() => expect(activePhoto(store.getState())?.id).not.toBe(first.id));

    // AltGr is Ctrl+Alt on Windows/Linux: it must not trigger Previous.
    altGraphKeyDown({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true });
    expect(applyCalls(fake)).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'v', code: 'KeyV', ctrlKey: true, altKey: true });
    await waitFor(() => expect(applyCalls(fake)).toHaveLength(1));
    const args = applyCalls(fake)[0]!.args[0] as {
      photoIds: string[];
      params: Record<string, unknown>;
      groups: string[];
    };
    expect(args.params.Exposure2012).toBe(1.25);
    expect(args.photoIds).toEqual([activePhoto(store.getState())?.id]);
    expect(args.groups).not.toContain('crop');
  });

  it('ignores Swedish å/ä/ö and dead keys', async () => {
    const { store } = await renderApp();
    const before = activePhoto(store.getState())?.id;
    for (const key of ['å', 'ä', 'ö', 'Dead']) fireEvent.keyDown(window, { key });
    expect(activePhoto(store.getState())?.id).toBe(before);
    expect(store.getState().selection).toHaveLength(1);
  });
});
