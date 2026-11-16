import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SettingsFolderInfo, SourceConfig } from '@ee/contracts';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

type Handlers = NonNullable<Parameters<typeof createFakeBridge>[0]>['handlers'];

async function renderApp(handlers: Handlers = {}) {
  const fake = createFakeBridge({ handlers });
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

describe('Settings → Settings folder', () => {
  it('shows the folder in use and offers to copy into an empty one', async () => {
    const folder: SettingsFolderInfo = {
      path: '/mock/settings',
      defaultPath: '/mock/settings',
      isDefault: true,
      hasSettings: true,
    };
    const { fake } = await renderApp({
      'settings:folder': async () => folder,
      'dialog:pick': async () => ['/mock/empty-settings'],
      'settings:inspectFolder': async (...args) => ({
        path: (args[0] as { path: string }).path,
        hasSettings: false,
      }),
      'settings:copyToFolder': async (...args) => {
        folder.path = (args[0] as { path: string }).path;
        folder.isDefault = false;
        return { ...folder };
      },
    });
    const dialog = await openSettings();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Settings folder' }));

    expect((await screen.findByTestId('settings-folder-path')).textContent).toBe('/mock/settings');
    expect(within(dialog).getByText('Default')).toBeTruthy();

    fireEvent.click(within(dialog).getByTestId('choose-settings-folder'));
    await within(dialog).findByTestId('settings-folder-offer');
    expect(within(dialog).getByText(/\/mock\/empty-settings is empty/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy settings' }));
    await waitFor(() =>
      expect(
        fake.calls.filter((call) => call.channel === 'settings:copyToFolder').at(-1)?.args[0],
      ).toEqual({ path: '/mock/empty-settings' }),
    );
    expect(await within(dialog).findByText(/Copied the settings to/)).toBeTruthy();
    expect(screen.getByTestId('settings-folder-path').textContent).toBe('/mock/empty-settings');
  });

  it('uses the settings a folder already has without offering to copy over them', async () => {
    const folder: SettingsFolderInfo = {
      path: '/mock/settings',
      defaultPath: '/mock/settings',
      isDefault: true,
      hasSettings: true,
    };
    const { fake } = await renderApp({
      'settings:folder': async () => folder,
      'dialog:pick': async () => ['/mock/synced-settings'],
      'settings:inspectFolder': async (...args) => ({
        path: (args[0] as { path: string }).path,
        hasSettings: true,
      }),
      'settings:useFolder': async (...args) => {
        folder.path = (args[0] as { path: string }).path;
        folder.isDefault = false;
        return { ...folder };
      },
    });
    const dialog = await openSettings();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Settings folder' }));
    fireEvent.click(await within(dialog).findByTestId('choose-settings-folder'));

    await waitFor(() =>
      expect(
        fake.calls.filter((call) => call.channel === 'settings:useFolder').at(-1)?.args[0],
      ).toEqual({ path: '/mock/synced-settings' }),
    );
    expect(await within(dialog).findByText(/Using the settings in/)).toBeTruthy();
    expect(within(dialog).queryByTestId('settings-folder-offer')).toBeNull();
  });
});

describe('Settings → Sources with a password that stayed on the other computer', () => {
  it('says Password needed for a synced source whose secret is absent here', async () => {
    const synced: SourceConfig = {
      id: 'synced-pool' as SourceConfig['id'],
      kind: 'ftp',
      name: 'Synced pool',
      host: 'ftp.sportfotografen.se',
      port: 21,
      username: 'photographer',
      credentialRef: 'cred-from-the-other-computer',
      remotePath: '/incoming',
      pollIntervalMs: 5000,
      deleteAfterDownload: false,
      security: 'none',
    };
    await renderApp({
      'sources:list': async () => [synced],
      'credentials:present': async () => [],
    });
    const dialog = await openSettings();
    expect((await within(dialog).findAllByText(/Password needed/)).length).toBeGreaterThan(0);
    // The anonymous placeholder is not offered for a reference it cannot find.
    expect((within(dialog).getByLabelText('Password') as HTMLInputElement).placeholder).toBe(
      'Not stored on this computer',
    );
  });
});
