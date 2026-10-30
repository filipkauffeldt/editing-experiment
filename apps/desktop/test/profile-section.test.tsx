import type { ProfileListing, ProfileResolution } from '@ee/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, paramsForPhoto, activePhoto, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const listing = (
  over: Partial<ProfileListing> & Pick<ProfileListing, 'name' | 'group'>,
): ProfileListing => ({
  id: `/profiles/${over.name}`,
  kind: 'camera',
  camera: 'Nikon Z 6_2',
  path: `/profiles/${over.name}`,
  ...over,
});

const PROFILES: ProfileListing[] = [
  listing({ name: 'Adobe Standard', group: 'adobe-raw' }),
  listing({
    name: 'Adobe Color',
    group: 'adobe-raw',
    kind: 'look',
    camera: '',
    base: 'Adobe Standard',
    uuid: 'B952C231111CD8E0ECCF14B86BAA7077',
    supportsAmount: true,
  }),
  listing({ name: 'Camera Flat', group: 'camera-matching' }),
  listing({ name: 'Punch', group: 'other' }),
];

const stores: AppStore[] = [];

async function renderApp(resolve: ProfileResolution = { status: 'none' }): Promise<AppStore> {
  const fake = createFakeBridge({
    handlers: {
      'profiles:list': async () => ({ camera: 'NIKON Z 6_2', profiles: PROFILES }),
      'profiles:resolve': async () => resolve,
    },
  });
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  await waitFor(() => expect(store.getState().selectedId).toBeDefined());
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const params = (store: AppStore) => paramsForPhoto(store.getState(), activePhoto(store.getState()));

describe('the Profile select', () => {
  it('offers the profiles grouped Adobe Raw / Camera Matching / Other', async () => {
    await renderApp();
    const select = await screen.findByRole('combobox', { name: 'Camera profile' });
    await waitFor(() => expect(within(select).getByText('Adobe Standard')).toBeDefined());
    const groups = [...select.querySelectorAll('optgroup')].map((g) => [
      g.label,
      [...g.querySelectorAll('option')].map((o) => o.textContent),
    ]);
    expect(groups).toEqual([
      ['Adobe Raw', ['Adobe Standard', 'Adobe Color']],
      ['Camera Matching', ['Camera Flat']],
      ['Other', ['Punch']],
    ]);
    expect(within(select).getAllByRole('option')[0]?.textContent).toBe('Camera matrix');
  });

  it('writes a camera profile, and a look with its base profile, to the settings', async () => {
    const store = await renderApp();
    const select = await screen.findByRole('combobox', { name: 'Camera profile' });
    await waitFor(() => expect(within(select).getByText('Camera Flat')).toBeDefined());

    fireEvent.change(select, { target: { value: '/profiles/Camera Flat' } });
    expect(params(store)).toMatchObject({ CameraProfile: 'Camera Flat' });
    expect(params(store).LookName).toBeUndefined();

    fireEvent.change(select, { target: { value: '/profiles/Adobe Color' } });
    expect(params(store)).toMatchObject({
      CameraProfile: 'Adobe Standard',
      LookName: 'Adobe Color',
      LookUUID: 'B952C231111CD8E0ECCF14B86BAA7077',
    });
    // The look has an Amount, which is a fraction in the settings.
    store.setLookAmount(0.5);
    expect(params(store).LookAmount).toBe(0.5);

    fireEvent.change(select, { target: { value: '' } });
    expect(params(store).CameraProfile).toBeUndefined();
    expect(params(store).LookName).toBeUndefined();
    expect(params(store).LookAmount).toBeUndefined();
  });

  it('keeps the name of a profile this machine does not have and says so', async () => {
    const store = await renderApp({
      status: 'missing',
      reason: 'No "Adobe Standard" profile for Z 6.',
    });
    store.setCameraProfile({
      ...PROFILES[0]!,
      name: 'Adobe Standard',
    });
    const note = await screen.findByText(/is not in the profile folders/);
    expect(note.textContent).toContain('The name is kept');
    expect(params(store).CameraProfile).toBe('Adobe Standard');
    const select = screen.getByRole('combobox', { name: 'Camera profile' });
    // The listing has it for this camera in this test; with none listed the name stays selectable.
    expect(select).toBeDefined();
  });

  it('opens the Profiles settings from the link', async () => {
    const store = await renderApp();
    fireEvent.click(await screen.findByRole('button', { name: /Browse profile folders/ }));
    expect(store.getState().dialog).toBe('profiles');
    expect(await screen.findByTestId('profiles-settings')).toBeDefined();
  });
});
