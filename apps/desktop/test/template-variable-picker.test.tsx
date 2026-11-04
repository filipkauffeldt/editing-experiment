import type { ExportPreset } from '@ee/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
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

const openSettings = async (tab: 'Ingest' | 'Destinations'): Promise<HTMLElement> => {
  fireEvent.click(screen.getByTestId('open-settings'));
  const dialog = await screen.findByTestId('settings-dialog');
  fireEvent.click(within(dialog).getByRole('tab', { name: tab }));
  return dialog;
};

const picker = async (testId: string): Promise<HTMLElement> => {
  fireEvent.click(screen.getByTestId(`${testId}-variables`));
  return screen.findByTestId(`${testId}-variable-list`);
};

const insertButton = (list: HTMLElement, template: string): HTMLElement =>
  within(list).getByRole('button', { name: `Insert ${template}` });

describe('template variable picker', () => {
  it('lists export variables, inserts at the caret and saves the preset', async () => {
    const { fake } = await renderApp();
    const user = userEvent.setup();
    const dialog = await openExport();
    const folder = within(dialog).getByTestId('folder-template') as HTMLInputElement;
    fireEvent.change(folder, { target: { value: '{folder}' } });
    folder.focus();
    folder.setSelectionRange(8, 8);

    const list = await picker('folder-template');
    expect(insertButton(list, '{filename}')).toBeTruthy();
    expect(insertButton(list, '{date}')).toBeTruthy();
    expect(insertButton(list, '{preset}')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Insert {sequence}' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Insert {seq:4}' })).toBeNull();

    await user.click(insertButton(list, '{filename}'));
    expect(folder.value).toBe('{folder}{filename}');
    expect(document.activeElement).toBe(folder);
    expect(screen.queryByTestId('folder-template-variable-list')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Save preset' }));
    await waitFor(() => {
      const call = fake.calls
        .filter((candidate) => candidate.channel === 'exportPresets:save')
        .at(-1);
      expect((call?.args[0] as { preset: ExportPreset }).preset.folderTemplate).toBe(
        '{folder}{filename}',
      );
    });
  });

  it('replaces a selected range in the file name template and works from the keyboard', async () => {
    const { fake } = await renderApp();
    const user = userEvent.setup();
    const dialog = await openExport();
    const file = within(dialog).getByTestId('filename-template') as HTMLInputElement;
    fireEvent.change(file, { target: { value: 'Desk_photo' } });
    file.focus();
    file.setSelectionRange(0, 4);

    const list = await picker('filename-template');
    await user.click(insertButton(list, '{date}'));
    expect(file.value).toBe('{date}_photo');

    // Keyboard: Enter on the trigger opens the list, ArrowDown reaches the
    // first entry and Enter inserts it without the mouse.
    fireEvent.change(file, { target: { value: '{date}' } });
    file.focus();
    file.setSelectionRange(6, 6);
    const trigger = within(dialog).getByTestId('filename-template-variables');
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByTestId('filename-template-variable-list');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(file.value).toBe('{date}{filename}');
    expect(document.activeElement).toBe(file);

    await user.click(within(dialog).getByRole('button', { name: 'Save preset' }));
    await waitFor(() => {
      const call = fake.calls
        .filter((candidate) => candidate.channel === 'exportPresets:save')
        .at(-1);
      expect((call?.args[0] as { preset: ExportPreset }).preset.fileNameTemplate).toBe(
        '{date}{filename}',
      );
    });
  });

  it('closes on Escape and outside clicks without closing the dialog', async () => {
    await renderApp();
    const dialog = await openExport();
    await picker('folder-template');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('folder-template-variable-list')).toBeNull());
    expect(screen.queryByTestId('export-dialog')).toBe(dialog);

    await picker('folder-template');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId('folder-template-variable-list')).toBeNull());
    expect(screen.queryByTestId('export-dialog')).toBe(dialog);
  });

  it('lists ingest variables in both ingest templates, inserts {seq:4} and saves them', async () => {
    const { fake } = await renderApp();
    const user = userEvent.setup();
    const dialog = await openSettings('Ingest');
    const rename = within(dialog).getByTestId('ingest-rename-template') as HTMLInputElement;
    fireEvent.change(rename, { target: { value: '2026_' } });
    rename.focus();
    rename.setSelectionRange(5, 5);

    const list = await picker('ingest-rename-template');
    expect(insertButton(list, '{seq:4}')).toBeTruthy();
    expect(insertButton(list, '{sourceName}')).toBeTruthy();
    expect(insertButton(list, '{date:YYYY-MM-DD}')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Insert {preset}' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Insert {model}' })).toBeNull();
    await user.click(insertButton(list, '{seq:4}'));
    expect(rename.value).toBe('2026_{seq:4}');

    const subfolder = within(dialog).getByTestId('ingest-subfolder-template') as HTMLInputElement;
    const subfolderList = await picker('ingest-subfolder-template');
    expect(insertButton(subfolderList, '{sourceName}')).toBeTruthy();
    expect(within(subfolderList).queryByRole('button', { name: 'Insert {preset}' })).toBeNull();
    await user.click(insertButton(subfolderList, '{date}'));
    expect(subfolder.value).toContain('{date}');

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = fake.calls.filter((candidate) => candidate.channel === 'settings:set').at(-1);
      expect((call?.args[0] as { ingest: { renameTemplate: string } }).ingest.renameTemplate).toBe(
        '2026_{seq:4}',
      );
    });
  });

  it('shows a quiet unknown-variable message per field from the registry', async () => {
    await renderApp();
    const dialog = await openExport();
    const folder = within(dialog).getByTestId('folder-template') as HTMLInputElement;
    fireEvent.change(folder, { target: { value: '{folder}/{bogus}' } });
    expect(within(dialog).getByTestId('folder-template-unknown').textContent).toBe(
      'Unknown variable: {bogus}',
    );
    fireEvent.change(folder, { target: { value: '{folder}/{preset}' } });
    expect(within(dialog).queryByTestId('folder-template-unknown')).toBeNull();

    const settings = await openSettings('Ingest');
    const rename = within(settings).getByTestId('ingest-rename-template') as HTMLInputElement;
    fireEvent.change(rename, { target: { value: '{seq:4}/{sourceName}' } });
    expect(within(settings).queryByTestId('ingest-rename-template-unknown')).toBeNull();
    fireEvent.change(rename, { target: { value: '{preset}/{model}' } });
    expect(within(settings).getByTestId('ingest-rename-template-unknown').textContent).toBe(
      'Unknown variables: {preset}, {model}',
    );
  });

  it('lists destination path variables and not the ones its context cannot provide', async () => {
    await renderApp();
    const dialog = await openSettings('Destinations');
    const list = await picker('destination-remote-path-template');
    expect(insertButton(list, '{filename}')).toBeTruthy();
    expect(insertButton(list, '{event}')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Insert {folder}' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Insert {preset}' })).toBeNull();

    const field = within(dialog).getByTestId(
      'destination-remote-path-template',
    ) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '{date}/{folder}/{preset}' } });
    expect(within(dialog).getByTestId('destination-remote-path-template-unknown').textContent).toBe(
      'Unknown variables: {folder}, {preset}',
    );
  });
});
