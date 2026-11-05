import type { ProfileListing, ProfileResolution } from '@ee/contracts';
import {
  asShotTemperatureTint,
  multipliersFromTemperatureTint,
  profileColorModel,
} from '@ee/develop-gl';
import { profileData } from '@ee/develop-gl/profile/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, paramsForPhoto, activePhoto, type AppStore } from '../src/renderer/store';
import type { FullResolutionRenderRequest } from '../src/renderer/export-render';
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
    // "Camera matrix" is a saved choice: an absent profile would now mean the default one.
    expect(params(store).CameraProfileChoice).toBe('none');

    // Any profile takes the choice away again.
    fireEvent.change(select, { target: { value: '/profiles/Camera Flat' } });
    expect(params(store).CameraProfileChoice).toBeUndefined();
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

describe('exports render through the profile', () => {
  it('hands the resolved profile and the preset size to the export render', async () => {
    const camera = {
      name: 'Camera Flat',
      camera: 'Nikon Z 6_2',
      copyright: '',
      illuminants: [6504],
      colorMatrices: [],
      forwardMatrices: [[1, 0, 0, 0, 1, 0, 0, 0, 1]],
      hueSatMaps: [],
      baselineExposureOffset: 0,
      defaultBlackRender: 'none' as const,
      embedPolicy: 0,
    };
    const requests: FullResolutionRenderRequest[] = [];
    const fake = createFakeBridge({
      handlers: {
        'profiles:resolve': async () => ({ status: 'ok', profile: { camera, amount: 1 } }),
      },
    });
    window.eeTransport = fake.transport;
    const store = createAppStore(fake.bridge, {
      renderForExport: async (request) => {
        requests.push(request);
        return { width: 1, height: 1, rgba: new Uint8Array(4) };
      },
    });
    stores.push(store);
    render(<App store={store} />);
    await screen.findByTestId('film-strip');
    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    const photo = activePhoto(store.getState());
    store.setCameraProfile({ ...PROFILES[2]! });
    store.setLookAmount(undefined);
    const preset = store.getState().exportPresets[0];
    expect(photo && preset).toBeTruthy();
    fake.emit('jobs:event', {
      type: 'export.render',
      at: 0,
      jobId: 'job-1' as never,
      requestId: 'r1',
      photoId: photo!.id,
      presetId: preset!.id,
      version: 'develop',
      opsKey: '',
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.profile?.camera.name).toBe('Camera Flat');
    expect(requests[0]?.resize).toEqual(preset!.resize);
    expect(requests[0]?.params.CameraProfile).toBe('Camera Flat');
  });
});

describe('the default profile (Camera Standard)', () => {
  const standard = {
    name: 'Camera Standard',
    camera: 'Nikon Z 6_2',
    copyright: '',
    illuminants: [6504],
    colorMatrices: [],
    forwardMatrices: [[1, 0, 0, 0, 1, 0, 0, 0, 1]],
    hueSatMaps: [],
    baselineExposureOffset: 0,
    defaultBlackRender: 'none' as const,
    embedPolicy: 0,
  };
  const withDefault: ProfileListing[] = [
    ...PROFILES,
    listing({ name: 'Camera Standard', group: 'camera-matching' }),
  ];
  const defaultAnswer: ProfileResolution = {
    status: 'ok',
    profile: { camera: standard, amount: 1 },
    defaultKey: '/profiles/Camera Standard|1',
  };

  /** A store whose backend resolves like the real one: by what the settings name. */
  async function open(answer: (request: unknown) => ProfileResolution) {
    const requests: unknown[] = [];
    const exports: FullResolutionRenderRequest[] = [];
    const fake = createFakeBridge({
      handlers: {
        'profiles:list': async () => ({ camera: 'NIKON Z 6_2', profiles: withDefault }),
        'profiles:resolve': async (request) => {
          requests.push(request);
          return answer(request);
        },
      },
    });
    window.eeTransport = fake.transport;
    const store = createAppStore(fake.bridge, {
      renderForExport: async (request) => {
        exports.push(request);
        return { width: 1, height: 1, rgba: new Uint8Array(4) };
      },
    });
    stores.push(store);
    render(<App store={store} />);
    await screen.findByTestId('film-strip');
    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    return { store, fake, requests, exports };
  }
  const writes = (fake: ReturnType<typeof createFakeBridge>) =>
    fake.calls.filter((call) => call.channel === 'develop:setParams');

  it('is selected and marked in the list without marking the photo as edited or writing anything', async () => {
    const { store, fake } = await open(() => defaultAnswer);
    const select = await screen.findByRole('combobox', { name: 'Camera profile' });
    await waitFor(() =>
      expect((select as HTMLSelectElement).value).toBe('/profiles/Camera Standard'),
    );
    const chosen = select.querySelector('option:checked');
    expect(chosen?.textContent).toBe('Camera Standard (default)');
    expect(await screen.findByTestId('profile-note')).toBeDefined();
    expect(screen.getByTestId('profile-note').textContent).toMatch(/default for this camera/);

    expect(params(store).CameraProfile).toBeUndefined();
    expect(activePhoto(store.getState())?.status.edited).toBe(false);
    expect(writes(fake)).toEqual([]);
    expect(store.getState().photoProfiles[activePhoto(store.getState())!.id]).toMatchObject({
      status: 'ok',
      isDefault: true,
    });
  });

  it('is asked for once for the photos of one camera and file type, not once per photo', async () => {
    const { store, requests } = await open(() => defaultAnswer);
    await waitFor(() => expect(requests).toHaveLength(1));
    const photos = store.getState().photos;
    const kinds = new Set(
      photos.map((photo) => `${photo.fileName.split('.').pop()}|${photo.camera?.model}`),
    );
    for (const photo of photos) await store.profileForRender(photo.id, {});
    expect(requests.length).toBe(kinds.size);
    expect(kinds.size).toBeLessThan(photos.length);
  });

  it('is what canvas, thumbnails and export all draw through', async () => {
    const { store, fake, requests, exports } = await open(() => defaultAnswer);
    const photo = activePhoto(store.getState())!;
    const preset = store.getState().exportPresets[0]!;
    fake.emit('jobs:event', {
      type: 'export.render',
      at: 0,
      jobId: 'job-1' as never,
      requestId: 'r1',
      photoId: photo.id,
      presetId: preset.id,
      version: 'develop',
      opsKey: '',
    });
    await waitFor(() => expect(exports).toHaveLength(1));
    const canvas = store.getState().photoProfiles[photo.id];
    expect(canvas?.profile?.camera.name).toBe('Camera Standard');
    expect(exports[0]?.profile?.camera.name).toBe('Camera Standard');
    expect(exports[0]?.params.CameraProfile).toBeUndefined();
    const thumbnail = await store.profileForRender(photo.id, {});
    expect(thumbnail.profile?.camera.name).toBe('Camera Standard');
    expect(thumbnail.defaultKey).toBe('/profiles/Camera Standard|1');
    // One answer from the backend served all three.
    expect(requests).toHaveLength(1);
  });

  it('never replaces a profile or look the settings name, and "Camera matrix" is not asked for the default', async () => {
    const { store, requests } = await open((request) => {
      const asked = request as { profile?: string; none?: boolean };
      if (asked.none) return { status: 'none' };
      if (asked.profile === 'Adobe Vivid') return { status: 'missing', reason: 'No such profile.' };
      return defaultAnswer;
    });
    const photo = activePhoto(store.getState())!;
    // A missing named profile stays missing: no silent Camera Standard.
    const missing = await store.profileForRender(photo.id, { CameraProfile: 'Adobe Vivid' });
    expect(missing.profile).toBeNull();
    store.loadPhotoProfile(photo.id, { CameraProfile: 'Adobe Vivid' });
    await waitFor(() =>
      expect(store.getState().photoProfiles[photo.id]).toMatchObject({ status: 'missing' }),
    );
    // An explicit Camera matrix needs no answer at all.
    const before = requests.length;
    const none = await store.profileForRender(photo.id, { CameraProfileChoice: 'none' });
    expect(none).toEqual({ profile: null, defaultKey: '' });
    store.loadPhotoProfile(photo.id, { CameraProfileChoice: 'none' });
    expect(store.getState().photoProfiles[photo.id]?.status).toBe('none');
    expect(requests).toHaveLength(before);
    // A named profile wins over the marker if both are in the sidecar.
    const named = await store.profileForRender(photo.id, {
      CameraProfile: 'Camera Flat',
      CameraProfileChoice: 'none',
    });
    expect(named.profile).not.toBeNull();
  });

  it('saves "Camera matrix" and shows it selected, not the default', async () => {
    const { store, fake } = await open((request) =>
      (request as { none?: boolean }).none ? { status: 'none' } : defaultAnswer,
    );
    const select = await screen.findByRole('combobox', { name: 'Camera profile' });
    await waitFor(() =>
      expect((select as HTMLSelectElement).value).toBe('/profiles/Camera Standard'),
    );
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(writes(fake).length).toBeGreaterThan(0));
    expect(params(store).CameraProfileChoice).toBe('none');
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe(''));
    expect(select.querySelector('option:checked')?.textContent).toBe('Camera matrix');
  });

  it('says why an unreadable default is not used and still draws the photo', async () => {
    const { store } = await open(() => ({
      status: 'none',
      problem: 'Camera Standard: The profile has neither a ColorMatrix nor a ForwardMatrix',
    }));
    const note = await screen.findByTestId('profile-note');
    expect(note.textContent).toMatch(/neither a ColorMatrix/);
    expect(note.textContent).toMatch(/camera matrix/);
    const photo = activePhoto(store.getState())!;
    expect((await store.profileForRender(photo.id, {})).profile).toBeNull();
  });

  it('asks again after the profile folders are rescanned', async () => {
    let installed = false;
    const { store, requests } = await open(() => (installed ? defaultAnswer : { status: 'none' }));
    const photo = activePhoto(store.getState())!;
    await waitFor(() => expect(store.getState().photoProfiles[photo.id]?.status).toBe('none'));
    installed = true;
    await store.loadProfileIndex(true);
    await waitFor(() =>
      expect(store.getState().photoProfiles[photo.id]).toMatchObject({
        status: 'ok',
        isDefault: true,
      }),
    );
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the as-shot temperature through the default profile, the number the picture is drawn with, and writes nothing', async () => {
    // A profile whose two ColorMatrices differ from the camera's own, so the numbers differ.
    const cameraMatrix = [0.821, -0.2534, -0.0683, -0.5355, 1.3338, 0.2212, -0.1143, 0.193, 0.6464];
    const warm = cameraMatrix.map((v, i) => (i % 3 === 0 ? v * 0.8 : v));
    const cool = cameraMatrix.map((v, i) => (i % 3 === 2 ? v * 1.3 : v));
    const profile = {
      camera: profileData({ name: 'Camera Standard', colorMatrices: [warm, cool] }),
      amount: 1,
    };
    const camera = {
      xyzToCamera: cameraMatrix,
      asShotMultipliers: multipliersFromTemperatureTint(cameraMatrix, 5400, 8),
    };
    const through = asShotTemperatureTint(camera, profileColorModel(profile, cameraMatrix));
    const plain = asShotTemperatureTint(camera, undefined);
    expect(Math.round(through.temperature)).not.toBe(Math.round(plain.temperature));

    const { store, fake } = await open(() => ({
      status: 'ok',
      profile,
      defaultKey: '/profiles/Camera Standard|1',
    }));
    const photo = activePhoto(store.getState())!;
    await waitFor(() =>
      expect(store.getState().photoProfiles[photo.id]).toMatchObject({ isDefault: true }),
    );
    act(() => store.setPhotoWhiteBalance(photo.id, camera));
    const temperature = screen.getByLabelText('Temperature value') as HTMLInputElement;
    await waitFor(() => expect(temperature.value).toBe(String(Math.round(through.temperature))));
    // Opening the photo stored nothing: it is still as shot.
    expect(params(store).Temperature).toBeUndefined();
    expect(params(store).Tint).toBeUndefined();
    expect(writes(fake)).toEqual([]);
  });
});
