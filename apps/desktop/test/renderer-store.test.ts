import { asPhotoId, type Photo } from '@ee/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge, type FakeBridge } from './fake-bridge';
import type { AppStore } from '../src/renderer/store';
import {
  activeDevelopVersion,
  activePhoto,
  cameraOptions,
  createAppStore,
  editParamsKey,
  paramsForPhoto,
  selectVisiblePhotos,
} from '../src/renderer/store';
import { mockPhotos, mockPresets } from '../src/shared/mock';

const stores: AppStore[] = [];

async function setup(options: Parameters<typeof createFakeBridge>[0] = {}): Promise<{
  store: AppStore;
  fake: FakeBridge;
}> {
  const fake = createFakeBridge(options);
  const store = createAppStore(fake.bridge);
  stores.push(store);
  await store.init();
  return { store, fake };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

const visible = (store: AppStore) => selectVisiblePhotos(store.getState());

describe('photo list', () => {
  it('sorts filenames naturally by default and by capture time on request', async () => {
    const base = mockPhotos().slice(0, 3);
    const photos: Photo[] = base.map((photo, index) => ({
      ...photo,
      fileName: ['_DSC10000.NEF', '_DSC999.NEF', '_DSC2000.NEF'][index] ?? photo.fileName,
      captureTime: ['2026-10-24T14:10:00', '2026-10-24T14:30:00', '2026-10-24T14:20:00'][index],
    }));
    const { store } = await setup({ photos });

    expect(visible(store).map((photo) => photo.fileName)).toEqual([
      '_DSC999.NEF',
      '_DSC2000.NEF',
      '_DSC10000.NEF',
    ]);

    store.setSort('capture-time');
    expect(visible(store).map((photo) => photo.fileName)).toEqual([
      '_DSC10000.NEF',
      '_DSC2000.NEF',
      '_DSC999.NEF',
    ]);

    store.setSort('filename');
    expect(visible(store)).toHaveLength(3);
  });

  it('selects the first visible photo and moves with selectRelative', async () => {
    const { store } = await setup();
    expect(activePhoto(store.getState())?.fileName).toBe('_DSC8330.NEF');

    store.selectRelative(1);
    expect(activePhoto(store.getState())?.fileName).toBe('_DSC8331.NEF');
    store.selectRelative(-1);
    expect(activePhoto(store.getState())?.fileName).toBe('_DSC8330.NEF');
  });
});

describe('filters and culling', () => {
  it('applies the quick filters to the mock photo set', async () => {
    const { store } = await setup();
    expect(visible(store)).toHaveLength(40);

    const selected = activePhoto(store.getState());
    if (!selected) throw new Error('no selection');
    store.toggleTag(selected.id);
    expect(visible(store)).toHaveLength(40);

    store.setQuickFilter('tagged');
    expect(visible(store).map((photo) => photo.id)).toEqual([selected.id]);

    store.setQuickFilter('untagged');
    expect(visible(store)).toHaveLength(39);

    store.setQuickFilter('edited');
    expect(visible(store)).toHaveLength(7);

    store.setQuickFilter('failed-uploads');
    expect(visible(store)).toHaveLength(1);
    expect(visible(store)[0]?.status.upload).toBe('failed');

    store.setQuickFilter('metadata-differs');
    expect(visible(store)).toHaveLength(1);

    store.setQuickFilter('not-uploaded');
    expect(visible(store)).toHaveLength(38);
  });

  it('combines camera and source filters', async () => {
    const { store } = await setup();
    const cameras = cameraOptions(store.getState().photos);
    expect(cameras).toHaveLength(2);

    store.setCameraFilter(cameras[0]?.key);
    expect(visible(store)).toHaveLength(20);

    store.setCameraFilter(undefined);
    const source = store.getState().sources[1];
    if (!source) throw new Error('no source');
    store.setSourceFilter(source.id);
    expect(visible(store)).toHaveLength(20);
    expect(visible(store).every((photo) => photo.sourceId === source.id)).toBe(true);
  });

  it('keeps a local tag and colour class per photo', async () => {
    const { store } = await setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');

    store.toggleTag(photo.id);
    store.setColorClass(3, photo.id);
    expect(store.getState().flags[photo.id]).toEqual({ tagged: true, colorClass: 3 });

    store.toggleTag(photo.id);
    store.setColorClass(0, photo.id);
    expect(store.getState().flags[photo.id]).toEqual({ tagged: false, colorClass: 0 });
  });
});

describe('metadata', () => {
  it('expands caption codes and reports unknown variables', async () => {
    const { store } = await setup();
    const photoId = asPhotoId('mock-07');
    store.select(photoId);
    await vi.waitFor(() => {
      expect(store.getState().metadata[photoId]).toBeDefined();
    });

    const result = await store.expandCaption(photoId);
    expect(result?.text).toContain('Manchester City v Liverpool at the Etihad Stadium.');
    expect(result?.text).toContain('{photographer}');
    expect(result?.unresolved).toEqual(['{photographer}']);
    expect(store.getState().metadataUnresolved[photoId]).toEqual(['{photographer}']);
  });

  it('debounces metadata writes through the bridge', async () => {
    const { store, fake } = await setup();
    const photoId = asPhotoId('mock-01');
    store.select(photoId);
    await vi.waitFor(() => expect(store.getState().metadata[photoId]).toBeDefined());

    store.updateMetadataField(photoId, 'headline', 'New headline');
    await vi.waitFor(() => {
      expect(fake.calls.some((call) => call.channel === 'metadata:write')).toBe(true);
    });
    const write = fake.calls.find((call) => call.channel === 'metadata:write');
    expect(write?.args[0]).toMatchObject({ photoId, fields: { headline: 'New headline' } });
  });

  it('reads the template and applies it to the selected photo', async () => {
    const { store } = await setup();
    const photoId = asPhotoId('mock-05');
    store.select(photoId);
    await vi.waitFor(() => expect(store.getState().template).toBeDefined());

    await store.applyTemplate('replace', photoId);
    expect(store.getState().metadata[photoId]?.city).toBe('Manchester');
    expect(store.getState().metadata[photoId]?.caption).toContain('{event}');
  });
});

describe('develop', () => {
  it('stores slider values, clamps to the spec and resets on request', async () => {
    const { store, fake } = await setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    await vi.waitFor(() =>
      expect(
        store.getState().editParams[editParamsKey(photo.id, activeDevelopVersion(photo)?.id)],
      ).toBeDefined(),
    );

    store.setSlider('Exposure2012', 12);
    expect(paramsForPhoto(store.getState(), photo).Exposure2012).toBe(5);
    await vi.waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'develop:setParams')).toBe(true),
    );

    store.resetSlider('Exposure2012');
    expect(paramsForPhoto(store.getState(), photo).Exposure2012).toBeUndefined();
  });

  it('applies presets and reports settings the importer did not support', async () => {
    const { store } = await setup();
    const preset = mockPresets()[0];
    if (!preset) throw new Error('no preset');
    store.applyPreset(preset);
    const photo = activePhoto(store.getState());
    expect(paramsForPhoto(store.getState(), photo).Contrast2012).toBe(15);
    expect(store.getState().presetNotice).toBeUndefined();

    const imported = await createFakeBridge().bridge.invoke('develop:importPreset', {
      path: '/tmp/x.xmp',
    });
    store.applyPreset(imported);
    expect(store.getState().presetNotice).toBe('2 settings not supported');
  });

  it('imports a preset through the dialog', async () => {
    const { store, fake } = await setup();
    await store.importPreset();
    expect(fake.calls.map((call) => call.channel)).toContain('dialog:pick');
    expect(store.getState().presets.some((preset) => preset.name === 'Imported preset')).toBe(true);
  });
});

describe('uploads and finish', () => {
  it('retries a failed upload', async () => {
    const { store } = await setup();
    const failed = store.getState().uploads.find((item) => item.state === 'failed');
    if (!failed) throw new Error('no failed upload');
    await store.retryUpload(failed.id);
    expect(store.getState().uploads.find((item) => item.id === failed.id)?.state).toBe('queued');
  });

  it('exports the current photo and advances to the next one', async () => {
    const { store, fake } = await setup();
    const first = activePhoto(store.getState());
    await store.finishAndNext();
    expect(fake.calls.some((call) => call.channel === 'export:photo')).toBe(true);
    expect(activePhoto(store.getState())?.id).not.toBe(first?.id);
    expect(activePhoto(store.getState())?.fileName).toBe('_DSC8331.NEF');
  });

  it('saves remote credentials before the source', async () => {
    const { store, fake } = await setup();
    const source = store.getState().sources.find((candidate) => candidate.kind === 'ftp');
    if (!source || source.kind !== 'ftp') throw new Error('no ftp source');

    await store.saveSource(source, { password: 'very-secret' });
    const channels = fake.calls.map((call) => call.channel);
    expect(channels.indexOf('credentials:set')).toBeLessThan(channels.indexOf('sources:save'));
    expect(channels).not.toContain('log');
    expect(store.getState().sources.find((candidate) => candidate.id === source.id)).toMatchObject({
      kind: 'ftp',
      credentialRef: source.credentialRef,
    });
  });
});

describe('settings', () => {
  it('starts ingest for every configured source', async () => {
    const { store, fake } = await setup();
    const ingest = store.getState().settings?.ingest;
    if (!ingest) throw new Error('no settings');
    const infos = await store.startIngest(ingest);
    expect(infos).toHaveLength(store.getState().sources.length);
    expect(fake.calls.some((call) => call.channel === 'ingest:start')).toBe(true);
  });
});
