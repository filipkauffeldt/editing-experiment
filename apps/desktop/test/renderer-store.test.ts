import {
  asPhotoId,
  asSourceId,
  type ExportPhotoResult,
  type IptcFields,
  type Photo,
  type SourceConfig,
} from '@ee/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropAspect } from '@ee/develop-gl';
import { createFakeBridge, type FakeBridge } from './fake-bridge';
import type { AppStore } from '../src/renderer/store';
import type { FullResolutionRenderRequest } from '../src/renderer/export-render';
import {
  activeDevelopVersion,
  activePhoto,
  cameraOptions,
  createAppStore,
  editParamsKey,
  paramsForPhoto,
  photoFlags,
  selectVisiblePhotos,
} from '../src/renderer/store';
import { mockPhotos, mockPresets } from '../src/shared/mock';

const stores: AppStore[] = [];

async function setup(
  options: Parameters<typeof createFakeBridge>[0] = {},
  renderForExport: (request: FullResolutionRenderRequest) => Promise<{
    width: number;
    height: number;
    rgba: Uint8Array;
  }> = async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
): Promise<{
  store: AppStore;
  fake: FakeBridge;
}> {
  const fake = createFakeBridge(options);
  const store = createAppStore(fake.bridge, { renderForExport });
  stores.push(store);
  await store.init();
  return { store, fake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const visible = (store: AppStore) => selectVisiblePhotos(store.getState());

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    expect(visible(store).map((photo) => photo.id)).toContain(selected.id);
    expect(visible(store)).toHaveLength(5);

    store.setQuickFilter('untagged');
    expect(visible(store)).toHaveLength(35);

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

  it('persists a tag and colour class on the photo', async () => {
    const { store, fake } = await setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');

    store.toggleTag(photo.id);
    store.setColorClass(3, photo.id);
    expect(photoFlags(store.getState(), photo.id)).toEqual({ tagged: true, colorClass: 3 });
    await vi.waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'photos:setLabels')).toBe(true),
    );

    store.toggleTag(photo.id);
    store.setColorClass(0, photo.id);
    expect(photoFlags(store.getState(), photo.id)).toEqual({ tagged: false, colorClass: 0 });
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
    expect(result?.text).toContain(
      'Manchester City Manchester City v Liverpool at the Etihad Stadium.',
    );
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
    expect(JSON.stringify(store.getState())).not.toContain('very-secret');
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

describe('crop editing', () => {
  it('edits a draft crop and saves it through develop:setParams', async () => {
    const { store, fake } = await setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const image = { width: photo.width ?? 0, height: photo.height ?? 0 };

    store.toggleCrop();
    const initial = store.getState().crop;
    expect(initial?.crop).toMatchObject({ left: 0, top: 0, right: 1, bottom: 1, angle: 0 });
    expect(initial?.aspect).toBe('original');

    store.setCropAspect('1:1');
    const square = store.getState().crop;
    if (!square) throw new Error('no crop session');
    expect(cropAspect(square.crop, image)).toBeCloseTo(1, 6);

    store.setCropAngle(3);
    expect(store.getState().crop?.crop.angle).toBeCloseTo(3, 9);

    const before = store.getState().crop?.crop;
    store.dragCropHandle('se', { x: 0.75, y: 0.75 });
    expect(store.getState().crop?.crop).not.toEqual(before);

    store.applyCrop();
    expect(store.getState().crop).toBeUndefined();
    const params = paramsForPhoto(store.getState(), photo);
    expect(params.crop?.angle).toBeCloseTo(3, 9);
    expect(cropAspect(params.crop!, image)).toBeCloseTo(1, 3);

    await vi.waitFor(() => {
      const writes = fake.calls.filter((call) => call.channel === 'develop:setParams');
      const last = writes.at(-1)?.args[0] as { params: { crop?: { angle: number } } } | undefined;
      expect(last?.params.crop?.angle).toBeCloseTo(3, 9);
    });
  });

  it('discards on cancel and restores the full frame on reset', async () => {
    const { store } = await setup();
    store.toggleCrop();
    store.setCropAspect('1:1');
    store.setCropAngle(10);
    store.cancelCrop();
    expect(store.getState().crop).toBeUndefined();
    expect(paramsForPhoto(store.getState(), activePhoto(store.getState())).crop).toBeUndefined();

    store.toggleCrop();
    store.setCropAspect('1:1');
    store.resetCrop();
    const session = store.getState().crop;
    expect(session?.aspect).toBe('original');
    expect(session?.crop).toEqual({ left: 0, top: 0, right: 1, bottom: 1, angle: 0 });
  });

  it('swaps portrait and landscape with X', async () => {
    const { store } = await setup();
    store.toggleCrop();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const image = { width: photo.width ?? 0, height: photo.height ?? 0 };
    store.setCropAspect('3:2');
    const landscape = cropAspect(store.getState().crop!.crop, image);
    store.swapCropOrientation();
    const portrait = cropAspect(store.getState().crop!.crop, image);
    expect(portrait).toBeCloseTo(1 / landscape, 6);
    expect(store.getState().crop?.flipped).toBe(true);
  });

  it('does not start retouch while cropping', async () => {
    const { store } = await setup();
    store.toggleCrop();
    expect(store.getState().crop).toBeDefined();
    store.toggleRetouch();
    expect(store.getState().retouch).toBeUndefined();
    expect(store.getState().crop).toBeDefined();
  });

  it('does not start cropping without the oriented image size', async () => {
    const base = mockPhotos()[0];
    if (!base) throw new Error('no mock photo');
    const photos: Photo[] = [{ ...base, width: undefined, height: undefined }];
    const { store } = await setup({ photos });
    store.toggleCrop();
    expect(store.getState().crop).toBeUndefined();
  });

  it('uses portrait dimensions instead of a landscape fallback', async () => {
    const base = mockPhotos()[0];
    if (!base) throw new Error('no mock photo');
    const photos: Photo[] = [{ ...base, width: 4000, height: 6000 }];
    const { store } = await setup({ photos });
    store.toggleCrop();
    const session = store.getState().crop;
    expect(session?.image).toEqual({ width: 4000, height: 6000 });
    store.setCropAspect('3:2');
    const portrait = store.getState().crop;
    if (!portrait) throw new Error('no crop session');
    expect(cropAspect(portrait.crop, portrait.image)).toBeCloseTo(3 / 2, 6);
    expect(portrait.image.height).toBeGreaterThan(portrait.image.width);
  });

  it('applies the draft crop before Finish & next', async () => {
    const renders: FullResolutionRenderRequest[] = [];
    const { store, fake } = await setup({}, async (request) => {
      renders.push(request);
      return { width: 1, height: 1, rgba: new Uint8Array(4) };
    });
    store.toggleCrop();
    store.setCropAspect('1:1');
    store.setCropAngle(-4);
    await store.finishAndNext();

    expect(renders[0]?.params.crop?.angle).toBeCloseTo(-4, 9);
    const channels = fake.calls.map((call) => call.channel);
    expect(channels.indexOf('develop:setParams')).toBeLessThan(channels.indexOf('export:photo'));
  });
});

describe('edit flushing', () => {
  it('writes the last slider value after a trailing throttle', async () => {
    const { store, fake } = await setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');

    store.setSlider('Exposure2012', 0.1);
    store.setSlider('Exposure2012', 0.2);
    store.setSlider('Exposure2012', 0.3);

    await vi.waitFor(() => {
      const writes = fake.calls.filter((call) => call.channel === 'develop:setParams');
      const last = writes.at(-1);
      expect((last?.args[0] as { params: { Exposure2012?: number } }).params.Exposure2012).toBe(
        0.3,
      );
    });
  });

  it('still saves metadata for the old photo after switching selection', async () => {
    const { store, fake } = await setup();
    const first = activePhoto(store.getState());
    if (!first) throw new Error('no selection');
    await vi.waitFor(() => expect(store.getState().metadata[first.id]).toBeDefined());

    store.updateMetadataField(first.id, 'headline', 'Queued before switching');
    store.select(asPhotoId('mock-02'));

    await vi.waitFor(() => {
      expect(
        fake.calls.some(
          (call) =>
            call.channel === 'metadata:write' &&
            (call.args[0] as { photoId: string }).photoId === first.id,
        ),
      ).toBe(true);
    });
  });

  it('flushes metadata and develop edits before export', async () => {
    const { store, fake } = await setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    await vi.waitFor(() => expect(store.getState().metadata[photo.id]).toBeDefined());

    store.updateMetadataField(photo.id, 'headline', 'Export headline');
    store.setSlider('Exposure2012', 0.75);
    await store.finishAndNext();

    const channels = fake.calls.map((call) => call.channel);
    const metadataWrite = channels.indexOf('metadata:write');
    const developWrite = channels.indexOf('develop:setParams');
    const exportCall = channels.indexOf('export:photo');
    expect(metadataWrite).toBeGreaterThanOrEqual(0);
    expect(metadataWrite).toBeLessThan(exportCall);
    expect(developWrite).toBeGreaterThanOrEqual(0);
    expect(developWrite).toBeLessThan(exportCall);
    const write = fake.calls.find((call) => call.channel === 'metadata:write');
    expect(write?.args[0]).toMatchObject({
      photoId: photo.id,
      fields: { headline: 'Export headline' },
    });
  });

  it('advances from the exported photo even if the selection changed meanwhile', async () => {
    const exportResult = deferred<ExportPhotoResult>();
    const { store, fake } = await setup({
      handlers: { 'export:photo': async () => exportResult.promise },
    });
    const first = activePhoto(store.getState());
    if (!first) throw new Error('no selection');

    const finished = store.finishAndNext();
    await vi.waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'export:photo')).toBe(true),
    );
    store.select(asPhotoId('mock-10'));
    exportResult.resolve({ path: '/out/x.jpg', fileName: 'x.jpg', uploads: [] });
    await finished;

    expect(activePhoto(store.getState())?.fileName).toBe('_DSC8331.NEF');
  });

  it('flushes pending metadata on dispose and stops listening', async () => {
    const { store, fake } = await setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    await vi.waitFor(() => expect(store.getState().metadata[photo.id]).toBeDefined());

    store.updateMetadataField(photo.id, 'headline', 'Saved on dispose');
    await store.dispose();

    expect(
      fake.calls.some(
        (call) =>
          call.channel === 'metadata:write' &&
          (call.args[0] as { fields: { headline?: string } }).fields.headline ===
            'Saved on dispose',
      ),
    ).toBe(true);

    const count = store.getState().photos.length;
    fake.emit('photos:added', { ...photo, id: asPhotoId('after-dispose') });
    expect(store.getState().photos).toHaveLength(count);
  });
});

describe('load races', () => {
  it('keeps metadata edited while the read was in flight', async () => {
    const read = deferred<IptcFields>();
    const { store, fake } = await setup({
      handlers: { 'metadata:read': async () => read.promise },
    });
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    await vi.waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'metadata:read')).toBe(true),
    );

    store.updateMetadataField(photo.id, 'headline', 'Local edit');
    read.resolve({ headline: 'Stale server value', city: 'Leeds' });

    await vi.waitFor(() => {
      expect(store.getState().metadata[photo.id]?.headline).toBe('Local edit');
      expect(store.getState().metadata[photo.id]?.city).toBe('Leeds');
    });
  });

  it('keeps develop params edited while the read was in flight', async () => {
    const read = deferred<{ Exposure2012?: number }>();
    const { store, fake } = await setup({
      handlers: { 'develop:getParams': async () => read.promise },
    });
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    await vi.waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'develop:getParams')).toBe(true),
    );

    store.setSlider('Exposure2012', 1.5);
    read.resolve({ Exposure2012: -2 });

    await vi.waitFor(() => {
      expect(paramsForPhoto(store.getState(), photo).Exposure2012).toBe(1.5);
    });
  });

  it('does not overwrite caption typing that started during expansion', async () => {
    const expanded = deferred<{ text: string; unresolved: string[] }>();
    const { store, fake } = await setup({
      handlers: { 'metadata:expandCaption': async () => expanded.promise },
    });
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    await vi.waitFor(() => expect(store.getState().metadata[photo.id]).toBeDefined());

    store.updateMetadataField(photo.id, 'caption', '=t1= at {event}');
    const pending = store.expandCaption(photo.id);
    await vi.waitFor(() =>
      expect(fake.calls.some((call) => call.channel === 'metadata:expandCaption')).toBe(true),
    );
    store.updateMetadataField(photo.id, 'caption', 'Typing kept');

    expanded.resolve({ text: 'Expanded result', unresolved: ['{unknown}'] });
    expect(await pending).toBeUndefined();
    expect(store.getState().metadata[photo.id]?.caption).toBe('Typing kept');
    expect(store.getState().metadataUnresolved[photo.id] ?? []).toEqual([]);
  });
});

describe('photo events', () => {
  it('coalesces added/updated events per frame and dedupes by id', async () => {
    const { store, fake } = await setup();
    const base = mockPhotos()[0];
    if (!base) throw new Error('no mock photo');
    const added: Photo = {
      ...base,
      id: asPhotoId('mock-new'),
      fileName: '_DSC9999.NEF',
      status: { ...base.status, upload: 'queued' },
    };
    fake.emit('photos:added', added);
    fake.emit('photos:added', { ...added, status: { ...added.status, upload: 'uploading' } });
    fake.emit('photos:updated', { ...added, status: { ...added.status, upload: 'failed' } });

    await vi.waitFor(() => {
      expect(store.getState().photos.filter((photo) => photo.id === added.id)).toHaveLength(1);
    });
    expect(store.getState().photos.find((photo) => photo.id === added.id)?.status.upload).toBe(
      'failed',
    );
  });

  it('applies upload and ingest job events to photos and runs', async () => {
    const { store, fake } = await setup();
    const upload = store.getState().uploads.find((item) => item.state === 'queued');
    if (!upload) throw new Error('no queued upload');

    fake.emit('jobs:event', {
      type: 'upload.state',
      at: Date.now(),
      uploadId: upload.id,
      photoId: upload.photoId,
      destinationId: upload.destinationId,
      state: 'failed',
      error: 'Network down',
    });
    expect(store.getState().uploads.find((item) => item.id === upload.id)).toMatchObject({
      state: 'failed',
      error: 'Network down',
    });
    expect(
      store.getState().photos.find((photo) => photo.id === upload.photoId)?.status.upload,
    ).toBe('failed');

    const source = store.getState().sources[0];
    if (!source) throw new Error('no source');
    fake.emit('jobs:event', {
      type: 'ingest.progress',
      at: Date.now(),
      jobId: 'test-job' as never,
      sourceId: source.id,
      filesTotal: 20,
      filesDone: 19,
      bytesDone: 123,
    });
    expect(store.getState().ingest[source.id]).toMatchObject({ filesDone: 19, filesTotal: 20 });
  });

  it('keeps the cached order when an upload event only changes status', async () => {
    const { store, fake } = await setup();
    const internals = store as unknown as { visibleCache?: { ids: unknown[] } };
    const order = internals.visibleCache?.ids;
    const upload = store.getState().uploads.find((item) => item.state === 'uploading');
    if (!upload) throw new Error('no uploading item');

    fake.emit('jobs:event', {
      type: 'upload.state',
      at: Date.now(),
      uploadId: upload.id,
      photoId: upload.photoId,
      destinationId: upload.destinationId,
      state: 'done',
    });

    expect(internals.visibleCache?.ids).toBe(order);
    expect(
      store.getState().photos.find((photo) => photo.id === upload.photoId)?.status.upload,
    ).toBe('done');
  });
});

describe('credentials cleanup', () => {
  it('removes a stored secret when a source or destination is removed', async () => {
    const { store, fake } = await setup();
    const source = store.getState().sources.find((item) => item.kind === 'ftp');
    const destination = store.getState().destinations.find((item) => item.kind === 'ftp');
    if (!source || source.kind !== 'ftp' || !destination || destination.kind !== 'ftp') {
      throw new Error('missing remote fixtures');
    }

    await store.removeSource(source.id);
    await store.removeDestination(destination.id);

    const removedRefs = fake.calls
      .filter((call) => call.channel === 'credentials:remove')
      .map((call) => (call.args[0] as { ref: string }).ref);
    expect(removedRefs).toContain(source.credentialRef);
    expect(removedRefs).toContain(destination.credentialRef);
  });

  it('removes an orphaned secret when saving the source fails', async () => {
    const { store, fake } = await setup({
      handlers: {
        'sources:save': async () => {
          throw new Error('disk full');
        },
      },
    });
    const fresh: SourceConfig = {
      id: asSourceId('fresh-source'),
      kind: 'ftp',
      name: 'Fresh FTP',
      host: 'fresh.test',
      port: 21,
      username: 'u',
      credentialRef: '',
      remotePath: '/in',
      pollIntervalMs: 5000,
      deleteAfterDownload: false,
      security: 'none',
    };

    await expect(store.saveSource(fresh, { password: 'secret' })).rejects.toThrow('disk full');
    expect(fake.calls.some((call) => call.channel === 'credentials:remove')).toBe(true);
  });

  it('tests a new remote source with an unsaved password and cleans up the temp ref', async () => {
    const { store, fake } = await setup();
    const fresh: SourceConfig = {
      id: asSourceId('unsaved-source'),
      kind: 'sftp',
      name: 'Unsaved SFTP',
      host: 'unsaved.test',
      port: 22,
      username: 'u',
      credentialRef: '',
      remotePath: '/in',
      pollIntervalMs: 5000,
      deleteAfterDownload: false,
    };

    const result = await store.testSource(fresh, { password: 'secret' });
    expect(result).toMatchObject({ ok: true });
    const testCall = fake.calls.find((call) => call.channel === 'sources:test');
    expect((testCall?.args[0] as { source: { credentialRef: string } }).source.credentialRef).toBe(
      'test-credential',
    );
    expect(fake.calls.some((call) => call.channel === 'credentials:remove')).toBe(true);
    expect(fake.calls.some((call) => call.channel === 'sources:save')).toBe(false);
    expect(store.getState().sources.some((source) => source.id === fresh.id)).toBe(false);
  });
});

describe('retouch sessions', () => {
  const rect = { type: 'rect' as const, x: 0.2, y: 0.2, w: 0.2, h: 0.2 };

  it('commits uncommitted shapes before Finish & next and exports them', async () => {
    const renders: FullResolutionRenderRequest[] = [];
    const { store, fake } = await setup({}, async (request) => {
      renders.push(request);
      return { width: 1, height: 1, rgba: new Uint8Array(4) };
    });
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');

    store.toggleRetouch();
    store.addRetouchShape(rect);
    await store.finishAndNext();

    const set = fake.calls.find((call) => call.channel === 'retouch:set');
    expect(set?.args[0]).toMatchObject({ photoId: photo.id, ops: [{ shapes: [rect] }] });
    expect(renders[0]?.ops).toMatchObject([{ type: 'mosaic', shapes: [rect] }]);
    const channels = fake.calls.map((call) => call.channel);
    expect(channels.indexOf('retouch:set')).toBeLessThan(channels.indexOf('export:photo'));
  });

  it('waits for an in-flight commit and does not save twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { store, fake } = await setup({
      handlers: {
        'retouch:set': async () => {
          started();
          await gate;
        },
      },
    });
    store.toggleRetouch();
    store.addRetouchShape(rect);

    const commit = store.commitRetouch();
    await running;
    const finish = store.finishAndNext();
    await vi.waitFor(() => expect(store.getState().retouch?.busy).toBe(true));
    expect(fake.calls.some((call) => call.channel === 'export:photo')).toBe(false);

    release();
    await Promise.all([commit, finish]);
    expect(fake.calls.filter((call) => call.channel === 'retouch:set')).toHaveLength(1);
    expect(fake.calls.some((call) => call.channel === 'export:photo')).toBe(true);
  });

  it('commits pending shapes before navigating to another photo', async () => {
    const { store, fake } = await setup();
    const first = activePhoto(store.getState());
    if (!first) throw new Error('no selection');
    store.toggleRetouch();
    store.addRetouchShape(rect);

    store.select(asPhotoId('mock-02'));

    await vi.waitFor(() => expect(activePhoto(store.getState())?.id).toBe('mock-02'));
    expect(fake.calls.some((call) => call.channel === 'retouch:set')).toBe(true);
    expect(store.getState().retouch).toBeUndefined();
  });

  it('saves on requestExitRetouch but keeps the session when Cancel discards', async () => {
    const { store, fake } = await setup();
    store.toggleRetouch();
    store.addRetouchShape(rect);
    await store.requestExitRetouch();
    expect(store.getState().retouch).toBeUndefined();
    expect(fake.calls.some((call) => call.channel === 'retouch:set')).toBe(true);

    await vi.waitFor(() => expect(store.getState().photos[0]).toBeDefined());
    store.toggleRetouch();
    store.addRetouchShape(rect);
    store.exitRetouch();
    expect(store.getState().retouch).toBeUndefined();
  });
});
