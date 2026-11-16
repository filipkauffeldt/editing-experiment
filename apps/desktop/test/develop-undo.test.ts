import {
  DEFAULT_COPY_SETTING_GROUPS,
  type EditParams,
  type Photo,
  type ProfileListing,
} from '@ee/contracts';
import type { AutoToneSettings } from '@ee/develop-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeDevelopVersion,
  activePhoto,
  createAppStore,
  editParamsKey,
  type AppStore,
} from '../src/renderer/store';
import { mockPresets } from '../src/shared/mock';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function setup(options: Parameters<typeof createFakeBridge>[0] = {}) {
  const fake = createFakeBridge(options);
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  await store.init();
  const photo = activePhoto(store.getState());
  if (!photo) throw new Error('no selection');
  await vi.waitFor(() =>
    expect(
      store.getState().editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)],
    ).toBeDefined(),
  );
  return { store, fake, photo };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const params = (store: AppStore, photo: Photo): EditParams =>
  store.getState().editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)] ?? {};

const lastWrite = (fake: FakeBridge): EditParams | undefined =>
  (
    fake.calls.filter((call) => call.channel === 'develop:setParams').at(-1)?.args[0] as
      { params: EditParams } | undefined
  )?.params;

const waitForWrite = (fake: FakeBridge, expected: EditParams): Promise<void> =>
  vi.waitFor(() => expect(lastWrite(fake)).toEqual(expected));

const cameraProfile: ProfileListing = {
  id: '/mock/profiles/Camera Standard.dcp',
  name: 'Camera Standard',
  kind: 'camera',
  group: 'camera-matching',
  camera: 'NIKON Z 9',
  path: '/mock/profiles/Camera Standard.dcp',
};

describe('develop undo and redo', () => {
  it('treats a slider drag as one step, restores absent keys as absent and redoes it', async () => {
    const { store, fake, photo } = await setup();

    store.beginDevelopGesture();
    for (const value of [0.1, 0.2, 0.3]) store.setSlider('Exposure2012', value);
    store.endDevelopGesture();
    expect(params(store, photo)).toEqual({ Exposure2012: 0.3 });
    await waitForWrite(fake, { Exposure2012: 0.3 });
    expect(store.canUndoDevelop()).toBe(true);

    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});

    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({ Exposure2012: 0.3 });
    await waitForWrite(fake, { Exposure2012: 0.3 });
  });

  it('makes a typed value from focus to commit one step', async () => {
    const { store, fake, photo } = await setup();

    store.beginDevelopGesture();
    store.setSlider('Contrast2012', 1);
    store.setSlider('Contrast2012', 12);
    store.setSlider('Contrast2012', 15);
    store.endDevelopGesture();

    expect(store.canUndoDevelop()).toBe(true);
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});
  });

  it('undoes a tone curve edit, a colour mixer change and a colour grading change', async () => {
    const { store, fake, photo } = await setup();

    const curve: EditParams['ToneCurvePV2012'] = [
      [0, 0],
      [128, 150],
      [255, 255],
    ];
    store.setCurvePoints('ToneCurvePV2012', curve);
    expect(params(store, photo).ToneCurvePV2012).toEqual(curve);
    await waitForWrite(fake, params(store, photo));
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo).ToneCurvePV2012).toEqual(curve);
    await waitForWrite(fake, { ToneCurvePV2012: curve });

    store.setSlider('SaturationAdjustmentRed', 25);
    await waitForWrite(fake, { ToneCurvePV2012: curve, SaturationAdjustmentRed: 25 });
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo).SaturationAdjustmentRed).toBeUndefined();
    await waitForWrite(fake, { ToneCurvePV2012: curve });

    store.setSlider('ColorGradeShadowHue', 40);
    await waitForWrite(fake, { ToneCurvePV2012: curve, ColorGradeShadowHue: 40 });
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo).ColorGradeShadowHue).toBeUndefined();
    await waitForWrite(fake, { ToneCurvePV2012: curve });
  });

  it('undoes a preset', async () => {
    const { store, fake, photo } = await setup();
    const preset = mockPresets()[0]!;

    store.applyPreset(preset);
    const applied = params(store, photo);
    expect(applied.Contrast2012).toBe(15);
    await waitForWrite(fake, applied);

    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual(applied);
    await waitForWrite(fake, applied);
  });

  it('undoes Auto tone, Auto WB and the white balance picker', async () => {
    const { store, fake, photo } = await setup();
    const tone: AutoToneSettings = {
      Exposure2012: 0.4,
      Contrast2012: 12,
      Highlights2012: -30,
      Shadows2012: 28,
      Whites2012: 6,
      Blacks2012: -8,
      Vibrance: 14,
      Saturation: 2,
    };

    store.applyAutoTone(tone);
    expect(params(store, photo)).toEqual(tone);
    await waitForWrite(fake, tone);
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual(tone);
    await waitForWrite(fake, tone);

    store.setWhiteBalance(5200, 9);
    const whiteBalance = params(store, photo);
    expect(whiteBalance).toMatchObject({ WhiteBalance: 'Custom', Temperature: 5200, Tint: 9 });
    await waitForWrite(fake, whiteBalance);
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual(tone);
    await waitForWrite(fake, tone);
  });

  it('undoes a profile change and lens correction settings', async () => {
    const { store, fake, photo } = await setup();

    store.setCameraProfile(cameraProfile);
    expect(params(store, photo).CameraProfile).toBe('Camera Standard');
    await waitForWrite(fake, params(store, photo));
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo).CameraProfile).toBe('Camera Standard');
    await waitForWrite(fake, { CameraProfile: 'Camera Standard' });

    store.setLensFlag('LensProfileEnable', true);
    expect(params(store, photo).LensProfileEnable).toBe(true);
    await waitForWrite(fake, params(store, photo));
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo).LensProfileEnable).toBeUndefined();
    await waitForWrite(fake, { CameraProfile: 'Camera Standard' });

    store.setLensProfileChoice('builtin');
    expect(params(store, photo).LensProfileChoice).toBe('builtin');
    await waitForWrite(fake, params(store, photo));
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo).LensProfileChoice).toBeUndefined();
    await waitForWrite(fake, { CameraProfile: 'Camera Standard' });

    store.setLookAmount(0.5);
    expect(params(store, photo).LookAmount).toBe(0.5);
    await waitForWrite(fake, { CameraProfile: 'Camera Standard', LookAmount: 0.5 });
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo).LookAmount).toBeUndefined();
    await waitForWrite(fake, { CameraProfile: 'Camera Standard' });
  });

  it('undoes a committed crop and a crop reset', async () => {
    const { store, fake, photo } = await setup();

    store.toggleCrop();
    store.setCropAspect('1:1');
    store.applyCrop();
    const cropped = params(store, photo);
    expect(cropped.crop).toBeDefined();
    await waitForWrite(fake, cropped);
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo).crop).toBeUndefined();
    await waitForWrite(fake, {});
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo).crop).toEqual(cropped.crop);
    await waitForWrite(fake, { crop: cropped.crop });

    store.toggleCrop();
    store.resetCrop();
    store.applyCrop();
    expect(params(store, photo).crop).toBeUndefined();
    await waitForWrite(fake, {});
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo).crop).toEqual(cropped.crop);
    await waitForWrite(fake, { crop: cropped.crop });
  });

  it('undoes a slider reset and a section reset with its parked values', async () => {
    const { store, fake, photo } = await setup();

    store.setSlider('Exposure2012', 1);
    await waitForWrite(fake, { Exposure2012: 1 });
    store.resetSlider('Exposure2012');
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({ Exposure2012: 1 });
    await waitForWrite(fake, { Exposure2012: 1 });
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});

    store.setSlider('Exposure2012', 1);
    store.setSectionEnabled('Tone', ['Exposure2012', 'Contrast2012'], false);
    const stashKey = `${photo.id}:Tone`;
    expect(params(store, photo)).toEqual({});
    expect(store.getState().sectionStash[stashKey]).toEqual({ Exposure2012: 1 });
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({ Exposure2012: 1 });
    expect(store.getState().sectionStash[stashKey]).toBeUndefined();
    await waitForWrite(fake, { Exposure2012: 1 });
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    expect(store.getState().sectionStash[stashKey]).toEqual({ Exposure2012: 1 });
    await waitForWrite(fake, {});
  });

  it('gives each photo of a batch paste its own step, and undo changes only the open one', async () => {
    const { store, fake, photo } = await setup();
    const second = store.getState().photos.find((candidate) => candidate.id !== photo.id);
    if (!second) throw new Error('no second photo');

    store.setSlider('Exposure2012', 0.5);
    await waitForWrite(fake, { Exposure2012: 0.5 });
    store.openCopySettings('copy');
    store.confirmCopySettings(DEFAULT_COPY_SETTING_GROUPS);

    store.select(second.id);
    store.select(photo.id, 'toggle');
    expect(store.getState().selection).toEqual([second.id, photo.id]);
    store.pasteSettings();
    await vi.waitFor(() => expect(params(store, second)).toEqual({ Exposure2012: 0.5 }));

    // The second photo is open now (the toggle made the clicked one active).
    expect(activePhoto(store.getState())?.id).toBe(photo.id);
    store.select(second.id);
    expect(params(store, second)).toEqual({ Exposure2012: 0.5 });
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, second)).toEqual({});
    expect(params(store, photo)).toEqual({ Exposure2012: 0.5 });
    await waitForWrite(fake, {});
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, second)).toEqual({ Exposure2012: 0.5 });
    await waitForWrite(fake, { Exposure2012: 0.5 });
  });

  it('undoes Sync and Previous', async () => {
    const { store, fake, photo } = await setup();
    const second = store.getState().photos.find((candidate) => candidate.id !== photo.id);
    if (!second) throw new Error('no second photo');

    store.setSlider('Exposure2012', 0.6);
    await waitForWrite(fake, { Exposure2012: 0.6 });
    store.select(second.id);
    store.select(photo.id, 'toggle');
    store.openCopySettings('sync');
    store.confirmCopySettings(DEFAULT_COPY_SETTING_GROUPS);
    await vi.waitFor(() => expect(params(store, second)).toEqual({ Exposure2012: 0.6 }));

    store.select(second.id);
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, second)).toEqual({});
    expect(params(store, photo)).toEqual({ Exposure2012: 0.6 });

    // Previous: the last edited photo before this one supplied the settings.
    store.select(photo.id);
    await vi.waitFor(() => expect(params(store, photo)).toEqual({ Exposure2012: 0.6 }));
    store.select(second.id);
    expect(store.getState().previousEdit?.photoId).toBe(photo.id);
    store.pastePreviousSettings();
    await vi.waitFor(() => expect(params(store, second)).toEqual({ Exposure2012: 0.6 }));
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, second)).toEqual({});
    await waitForWrite(fake, {});
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, second)).toEqual({ Exposure2012: 0.6 });
    await waitForWrite(fake, { Exposure2012: 0.6 });
  });

  it('resets every setting and the crop as one step, and undo restores them', async () => {
    const { store, fake, photo } = await setup();

    store.setSlider('Exposure2012', 0.8);
    store.toggleCrop();
    store.setCropAspect('1:1');
    store.applyCrop();
    const before = params(store, photo);
    expect(before.crop).toBeDefined();
    await waitForWrite(fake, before);

    store.resetAllDevelop();
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});
    expect(store.undoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual(before);
    await waitForWrite(fake, before);
    expect(store.redoDevelop()).toBe(true);
    expect(params(store, photo)).toEqual({});
    await waitForWrite(fake, {});
  });

  it('clears the redo steps on a new change and forgets a deleted photo', async () => {
    const { store, fake, photo } = await setup();

    store.setSlider('Exposure2012', 0.3);
    expect(store.undoDevelop()).toBe(true);
    expect(store.canRedoDevelop()).toBe(true);
    store.setSlider('Exposure2012', -0.2);
    expect(store.canRedoDevelop()).toBe(false);
    expect(store.redoDevelop()).toBe(false);
    expect(params(store, photo)).toEqual({ Exposure2012: -0.2 });

    fake.emit('photos:removed', { photoId: photo.id });
    expect(store.canUndoDevelop(photo.id)).toBe(false);
    expect(store.canRedoDevelop(photo.id)).toBe(false);
  });
});
