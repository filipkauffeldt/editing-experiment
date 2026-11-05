import type { ExportPreset } from '@ee/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, exportPhotoIds, type AppStore } from '../src/renderer/store';
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

const openExport = async (): Promise<HTMLElement> => {
  fireEvent.click(screen.getByTestId('open-export'));
  return screen.findByTestId('export-dialog');
};

const firstPhoto = (store: AppStore) => {
  const photoId = exportPhotoIds(store.getState())[0];
  const photo = store.getState().photos.find((candidate) => candidate.id === photoId);
  if (!photo) throw new Error('no first export photo');
  return photo;
};

const savedPresets = (fake: FakeBridge): ExportPreset[] =>
  fake.calls
    .filter((call) => call.channel === 'exportPresets:save')
    .map((call) => (call.args[0] as { preset: ExportPreset }).preset);

describe('export dialog', () => {
  it('titles the dialog with the number of photos', async () => {
    const { store } = await renderApp();
    const dialog = await openExport();
    expect(within(dialog).getByText('Export 1 photo')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(document.querySelector('button[title^="_DSC8330.NEF"]')!);
    fireEvent.click(document.querySelector('button[title^="_DSC8332.NEF"]')!, { shiftKey: true });
    expect(exportPhotoIds(store.getState())).toHaveLength(3);
    fireEvent.click(screen.getByTestId('open-export'));
    expect(
      within(await screen.findByTestId('export-dialog')).getByText('Export 3 photos'),
    ).toBeTruthy();
  });

  it('shows where the first photo will be saved for rename and keep', async () => {
    const { store } = await renderApp();
    const photo = firstPhoto(store);
    const dialog = await openExport();
    const target = within(dialog).getByTestId('export-target');

    const narrower = join(dirname(photo.path), 'export', '_DSC8330-web.jpg');
    fireEvent.change(within(dialog).getByTestId('filename-template'), {
      target: { value: '{filenamebase}-web' },
    });
    await waitFor(() => expect(target.textContent).toBe(narrower));

    const kept = join(dirname(photo.path), 'export', '_DSC8330.jpg');
    fireEvent.change(within(dialog).getByTestId('export-file-naming'), {
      target: { value: 'keep' },
    });
    await waitFor(() => expect(target.textContent).toBe(kept));
  });

  it('shows the template error in the Saves to line instead of failing the dialog', async () => {
    const { store } = await renderApp();
    const photo = firstPhoto(store);
    const dialog = await openExport();
    const target = within(dialog).getByTestId('export-target');
    fireEvent.change(within(dialog).getByTestId('folder-template'), {
      target: { value: '{photofolder}/../outside' },
    });

    await waitFor(() => expect(target.textContent).toMatch(/leaves the photo's folder/));
    expect(target.getAttribute('role')).toBe('status');
    expect(screen.getByTestId('export-dialog')).toBe(dialog);
    expect(within(dialog).getByTestId('folder-template')).toBeTruthy();
    expect(photo.path).toContain('_DSC8330.NEF');
  });

  it('debounces the target preview while a template is typed', async () => {
    const { store, fake } = await renderApp();
    const photo = firstPhoto(store);
    const dialog = await openExport();
    const target = within(dialog).getByTestId('export-target');
    await waitFor(() =>
      expect(target.textContent).toBe(join(dirname(photo.path), 'export', '_DSC8330.jpg')),
    );

    const previewCalls = (): number =>
      fake.calls.filter((call) => call.channel === 'export:previewTarget').length;
    const before = previewCalls();

    const folder = within(dialog).getByTestId('folder-template');
    fireEvent.change(folder, { target: { value: '{photofolder}/one' } });
    fireEvent.change(folder, { target: { value: '{photofolder}/two' } });
    expect(previewCalls()).toBe(before);

    await waitFor(() =>
      expect(target.textContent).toBe(join(dirname(photo.path), 'two', '_DSC8330.jpg')),
    );
    expect(previewCalls()).toBe(before + 1);
  });

  it('enables Save preset only while there are unsaved changes', async () => {
    const { fake } = await renderApp();
    const dialog = await openExport();
    const save = within(dialog).getByTestId('save-preset') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(dialog).queryByTestId('preset-unsaved')).toBeNull();

    const quality = within(dialog).getByLabelText('JPEG quality (1–100)') as HTMLInputElement;
    fireEvent.change(quality, { target: { value: '42' } });
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(within(dialog).getByTestId('preset-unsaved')).toBeTruthy();

    fireEvent.click(save);
    await waitFor(() => expect(savedPresets(fake).at(-1)?.quality).toBe(42));
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(within(dialog).queryByTestId('preset-unsaved')).toBeNull();
  });

  it('shows Set as active only for a preset that is not active', async () => {
    const { fake } = await renderApp();
    const dialog = await openExport();
    expect(within(dialog).queryByTestId('set-active-preset')).toBeNull();

    fireEvent.click(within(dialog).getByRole('option', { name: /^Web/ }));
    const setActive = await within(dialog).findByTestId('set-active-preset');
    fireEvent.click(setActive);

    await waitFor(() => {
      const call = fake.calls.filter((candidate) => candidate.channel === 'settings:set').at(-1);
      expect(call?.args[0]).toMatchObject({ activePresetId: 'mock-export-preset-web' });
    });
    await waitFor(() => expect(within(dialog).queryByTestId('set-active-preset')).toBeNull());
  });

  it('deletes the selected preset and keeps the editor valid', async () => {
    const { fake } = await renderApp();
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole('option', { name: /^Web/ }));
    fireEvent.click(within(dialog).getByTestId('delete-preset'));

    await waitFor(() => {
      const call = fake.calls
        .filter((candidate) => candidate.channel === 'exportPresets:remove')
        .at(-1);
      expect(call?.args[0]).toMatchObject({ presetId: 'mock-export-preset-web' });
    });
    await waitFor(() => expect(within(dialog).queryByRole('option', { name: /^Web/ })).toBeNull());
    expect((within(dialog).getByTestId('preset-name') as HTMLInputElement).value).toBe(
      'Sportfotografen',
    );
  });

  it('exports only with the values on screen', async () => {
    const { fake } = await renderApp();
    const dialog = await openExport();
    const quality = within(dialog).getByLabelText('JPEG quality (1–100)') as HTMLInputElement;
    fireEvent.change(quality, { target: { value: '42' } });
    fireEvent.change(within(dialog).getByTestId('filename-template'), {
      target: { value: '{filenamebase}-screen' },
    });

    fireEvent.click(within(dialog).getByTestId('export-only'));
    await waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'export:start')).toBe(true),
    );

    expect(savedPresets(fake).at(-1)).toMatchObject({
      quality: 42,
      fileNameTemplate: '{filenamebase}-screen',
    });
    const start = fake.calls.find((call) => call.channel === 'export:start');
    expect(start?.args[0]).toMatchObject({ send: [] });
  });

  it('exports and sends with the values on screen', async () => {
    const { fake } = await renderApp();
    const dialog = await openExport();
    const quality = within(dialog).getByLabelText('JPEG quality (1–100)') as HTMLInputElement;
    fireEvent.change(quality, { target: { value: '43' } });
    fireEvent.change(within(dialog).getByTestId('filename-template'), {
      target: { value: '{filenamebase}-send' },
    });

    fireEvent.click(within(dialog).getByTestId('export-send'));
    await waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'export:start')).toBe(true),
    );

    expect(savedPresets(fake).at(-1)).toMatchObject({
      quality: 43,
      fileNameTemplate: '{filenamebase}-send',
    });
    const start = fake.calls.find((call) => call.channel === 'export:start');
    expect(start?.args[0]).toMatchObject({ forceTop: true });
    expect(start?.args[0]).not.toHaveProperty('send');
  });
});
