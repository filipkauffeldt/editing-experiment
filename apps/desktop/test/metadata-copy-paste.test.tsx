import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('copy and paste metadata', () => {
  it('lists the global templates and code replacement files in Settings → Metadata', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('open-settings'));
    await screen.findByTestId('settings-dialog');
    fireEvent.click(screen.getByRole('tab', { name: 'Metadata' }));

    const section = await screen.findByTestId('metadata-settings');
    expect(section.textContent).toContain('premier-league.XMP');
    expect(section.textContent).toContain('night-match.XMP');
    expect(section.textContent).toContain('code-replacements.txt');
  });

  it('does not fire global rating or colour class shortcuts behind the dialog', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const before = { rating: photo.rating, colorClass: photo.colorClass };

    fireEvent.click(screen.getByTestId('metadata-copy'));
    await screen.findByTestId('copy-metadata-dialog');

    fireEvent.keyDown(window, { key: '3', code: 'Digit3' });
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true });

    const after = store.getState().photos.find((candidate) => candidate.id === photo.id);
    expect(after?.rating).toBe(before.rating);
    expect(after?.colorClass).toBe(before.colorClass);
  });

  it('lists grouped fields and copies only the checked ones, including empty values', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    await waitFor(() => expect(store.getState().metadata[photo.id]).toBeDefined());
    store.updateMetadataField(photo.id, 'city', '');
    await waitFor(() => expect(store.getState().metadata[photo.id]?.city).toBe(''));

    expect((screen.getByTestId('metadata-paste') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('metadata-copy'));
    const dialog = await screen.findByTestId('copy-metadata-dialog');
    expect(dialog.textContent).toContain('Caption');
    expect(dialog.textContent).toContain('Credits');
    expect(dialog.textContent).toContain('Location');
    expect(dialog.textContent).toContain('Event / job');
    expect((screen.getByTestId('metadata-copy-field-headline') as HTMLInputElement).checked).toBe(
      true,
    );

    fireEvent.click(screen.getByTestId('metadata-copy-none'));
    expect((screen.getByTestId('metadata-copy-field-headline') as HTMLInputElement).checked).toBe(
      false,
    );
    expect((screen.getByTestId('copy-metadata-confirm') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('metadata-copy-all'));
    expect((screen.getByTestId('metadata-copy-field-headline') as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByTestId('metadata-copy-field-city'));
    fireEvent.click(screen.getByTestId('metadata-copy-field-keywords'));
    fireEvent.click(screen.getByTestId('copy-metadata-confirm'));

    await waitFor(() => expect(store.getState().copiedMetadata).toBeDefined());
    const copied = store.getState().copiedMetadata;
    expect(copied?.sourcePhotoId).toBe(photo.id);
    expect(copied?.fields).not.toHaveProperty('city');
    expect(copied?.fields).not.toHaveProperty('keywords');
    expect(copied?.fields.headline).toBe(store.getState().metadata[photo.id]?.headline);
    expect(Object.keys(copied?.fields ?? {})).toHaveLength(17);

    const paste = screen.getByTestId('metadata-paste');
    expect((paste as HTMLButtonElement).disabled).toBe(false);
    expect(paste.title).toContain('17 fields');
  });

  it('pastes exactly the copied fields onto the whole selection', async () => {
    const { store, fake } = await renderApp();
    const first = activePhoto(store.getState());
    if (!first) throw new Error('no selection');

    fireEvent.click(screen.getByTestId('metadata-copy'));
    await screen.findByTestId('copy-metadata-dialog');
    fireEvent.click(screen.getByTestId('metadata-copy-field-caption'));
    fireEvent.click(screen.getByTestId('copy-metadata-confirm'));
    await waitFor(() => expect(store.getState().copiedMetadata).toBeDefined());
    const copied = store.getState().copiedMetadata?.fields;
    expect(copied).not.toHaveProperty('caption');

    fireEvent.click(thumbnail('_DSC8332.NEF'));
    fireEvent.click(thumbnail('_DSC8334.NEF'), { shiftKey: true });
    const targets = [...store.getState().selection];
    expect(targets).toHaveLength(3);
    const captions = await Promise.all(
      targets.map((photoId) => fake.bridge.invoke('metadata:read', { photoId })),
    );

    fireEvent.click(screen.getByTestId('metadata-paste'));
    await waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'metadata:writeFields')).toBe(true),
    );
    const call = fake.calls.find((candidate) => candidate.channel === 'metadata:writeFields');
    expect(call?.args[0]).toMatchObject({ photoIds: targets, fields: copied });

    for (const [index, photoId] of targets.entries()) {
      const fields = await fake.bridge.invoke('metadata:read', { photoId });
      expect(fields).toMatchObject(copied ?? {});
      expect(fields.caption).toBe(captions[index]?.caption);
    }
  });
});
