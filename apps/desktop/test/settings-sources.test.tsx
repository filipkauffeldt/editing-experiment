import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const openSettings = async (): Promise<HTMLElement> => {
  fireEvent.click(screen.getByTestId('open-settings'));
  return screen.findByTestId('settings-dialog');
};

const field = (dialog: HTMLElement, label: string): HTMLInputElement =>
  within(dialog).getByLabelText(label) as HTMLInputElement;

const type = (dialog: HTMLElement, label: string, value: string): void => {
  fireEvent.change(field(dialog, label), { target: { value } });
};

describe('settings sources', () => {
  it('has no developer subtitle', async () => {
    await renderApp();
    const dialog = await openSettings();
    expect(dialog.textContent).not.toContain('Everything the mock backend accepts here');
  });

  it('closes the Add menu with Escape without closing Settings', async () => {
    await renderApp();
    const dialog = await openSettings();
    fireEvent.click(within(dialog).getByTestId('add-source'));
    expect(within(dialog).getByRole('menu', { name: 'Add source' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(within(dialog).queryByRole('menu', { name: 'Add source' })).toBeNull();
    expect(screen.getByTestId('settings-dialog')).toBeTruthy();
  });

  it('adds every source kind from one Add menu', async () => {
    const { fake } = await renderApp();
    const dialog = await openSettings();

    const add = async (kind: 'folder' | 'card' | 'ftp' | 'sftp', heading: string) => {
      fireEvent.click(within(dialog).getByTestId('add-source'));
      fireEvent.click(await within(dialog).findByTestId(`add-source-${kind}`));
      expect(within(dialog).getByText(heading)).toBeTruthy();
    };

    await add('folder', 'New FOLDER source');
    type(dialog, 'Name', 'Folder card');
    type(dialog, 'Folder', '/photos/incoming');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save source' }));
    await waitFor(() =>
      expect(
        fake.calls.filter((call) => call.channel === 'sources:save').at(-1)?.args[0],
      ).toMatchObject({ source: { kind: 'folder', name: 'Folder card' } }),
    );

    await add('card', 'New CARD source');
    type(dialog, 'Name', 'Card A');
    type(dialog, 'Mount path', '/run/media/user/NIKON_Z9');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save source' }));
    await waitFor(() =>
      expect(
        fake.calls.filter((call) => call.channel === 'sources:save').at(-1)?.args[0],
      ).toMatchObject({ source: { kind: 'card', name: 'Card A' } }),
    );

    await add('ftp', 'New FTP source');
    type(dialog, 'Name', 'Pool FTP');
    type(dialog, 'Host', 'ftp.sportfotografen.se');
    type(dialog, 'Username', 'photographer');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save source' }));
    await waitFor(() =>
      expect(
        fake.calls.filter((call) => call.channel === 'sources:save').at(-1)?.args[0],
      ).toMatchObject({ source: { kind: 'ftp', name: 'Pool FTP' } }),
    );

    await add('sftp', 'New SFTP source');
    type(dialog, 'Name', 'Pool SFTP');
    type(dialog, 'Host', 'sftp.sportfotografen.se');
    type(dialog, 'Username', 'photographer');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save source' }));
    await waitFor(() =>
      expect(
        fake.calls.filter((call) => call.channel === 'sources:save').at(-1)?.args[0],
      ).toMatchObject({ source: { kind: 'sftp', name: 'Pool SFTP' } }),
    );
  });
});
