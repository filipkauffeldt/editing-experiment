import {
  type EditParams,
  type Photo,
  type RenderedImage,
  type RetouchOp,
  type SetEditedPreviewArgs,
} from '@ee/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditedPreviewRenderer } from '../src/renderer/edited-preview-scheduler';
import { activePhoto, createAppStore, type AppStore } from '../src/renderer/store';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const image = (size: number): RenderedImage => ({
  width: size,
  height: size,
  rgba: new Uint8Array(size * size * 4),
});

const rect = { type: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.2 } as const;
const stores: AppStore[] = [];

interface Rendered {
  photoId: Photo['id'];
  params: EditParams;
  ops: RetouchOp[];
}

async function setup(options: Parameters<typeof createFakeBridge>[0] = {}) {
  const rendered: Rendered[] = [];
  const renderEditedPreview: EditedPreviewRenderer = async (photo, params, ops) => {
    rendered.push({ photoId: photo.id, params, ops });
    return { thumb: image(2), preview: image(4) };
  };
  const fake = createFakeBridge(options);
  const store = createAppStore(fake.bridge, { renderEditedPreview });
  stores.push(store);
  await store.init();
  return { store, fake, rendered };
}

const stored = (fake: FakeBridge): SetEditedPreviewArgs[] =>
  fake.calls
    .filter((call) => call.channel === 'photos:setEditedPreview')
    .map((call) => call.args[0] as SetEditedPreviewArgs);

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
  vi.useRealTimers();
});

describe('edited thumbnails and previews in the store', () => {
  it('renders after the sliders have been quiet for 750 ms and stores the result', async () => {
    const { store, fake, rendered } = await setup();
    const photo = activePhoto(store.getState())!;

    store.setSlider('Exposure2012', 0.4);
    await vi.advanceTimersByTimeAsync(500);
    store.setSlider('Exposure2012', 0.8);
    await vi.advanceTimersByTimeAsync(700);
    expect(rendered).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(rendered).toHaveLength(1);
    // The render sees the latest slider value, once it reached the sidecar.
    expect(rendered[0]).toMatchObject({ photoId: photo.id, params: { Exposure2012: 0.8 } });
    expect(stored(fake)).toHaveLength(1);
    expect(stored(fake)[0]).toMatchObject({
      photoId: photo.id,
      retouchOps: [],
      params: { Exposure2012: 0.8 },
    });
    expect(fake.calls.some((c) => c.channel === 'develop:setParams')).toBe(true);

    // The backend's photos:updated reaches the store, so the <img> URL changes.
    await vi.advanceTimersByTimeAsync(50);
    expect(store.getState().photos.find((p) => p.id === photo.id)?.previewRevision).toBe(1);
  });

  it('renders a crop and a preset change as well', async () => {
    const { store, rendered } = await setup();
    const preset = store.getState().presets[0]!;
    store.applyPreset(preset);
    await vi.advanceTimersByTimeAsync(800);
    expect(rendered).toHaveLength(1);

    const crop = { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 0 };
    store.toggleCrop();
    store.setCropDraft(crop);
    store.applyCrop();
    await vi.advanceTimersByTimeAsync(800);
    expect(rendered).toHaveLength(2);
    expect(rendered[1]?.params.crop?.left).toBeCloseTo(crop.left, 6);
  });

  it('still renders a photo whose edit was pending when the user moved to the next one', async () => {
    const { store, fake, rendered } = await setup();
    const first = activePhoto(store.getState())!;
    store.setSlider('Exposure2012', 0.5);
    store.selectRelative(1);
    expect(activePhoto(store.getState())?.id).not.toBe(first.id);

    await settle();
    await settle();
    expect(rendered.map((r) => r.photoId)).toEqual([first.id]);
    expect(rendered[0]?.params).toMatchObject({ Exposure2012: 0.5 });
    expect(stored(fake)[0]?.photoId).toBe(first.id);
  });

  it('draws the mosaic promptly on commit, and stores the ops it drew with', async () => {
    const { store, fake, rendered } = await setup();
    const photo = activePhoto(store.getState())!;
    store.toggleRetouch();
    store.addRetouchShape(rect);
    await store.commitRetouch();
    // No 750 ms wait: the film strip must not keep an unmosaicked face.
    await settle();
    await settle();

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.ops).toMatchObject([{ type: 'mosaic', shapes: [rect] }]);
    expect(stored(fake)[0]).toMatchObject({
      photoId: photo.id,
      retouchOps: [{ type: 'mosaic', shapes: [rect] }],
    });
  });

  it('redraws when the retouch version is deleted', async () => {
    const { store, rendered } = await setup();
    store.setSlider('Exposure2012', 0.5);
    await vi.advanceTimersByTimeAsync(800);
    store.toggleRetouch();
    store.addRetouchShape(rect);
    await store.commitRetouch();
    await settle();
    await settle();
    const before = rendered.length;

    store.toggleRetouch();
    await store.deleteRetouchVersion();
    await settle();
    await settle();
    expect(rendered.length).toBe(before + 1);
    expect(rendered.at(-1)?.ops).toEqual([]);
  });

  it('does not render when the sliders are back to neutral before the render starts', async () => {
    const { store, rendered } = await setup();
    store.setSlider('Exposure2012', 0.5);
    store.resetSlider('Exposure2012');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rendered).toHaveLength(0);
  });

  it('renders photos that came in edited but stale when they are selected or shown', async () => {
    const [first, second, third] = mockPhotos();
    const edited = (photo: Photo): Photo => ({
      ...photo,
      status: { ...photo.status, edited: true },
      previewStale: true,
      versions: photo.versions.map((v) =>
        v.kind === 'develop' ? { ...v, ops: { Exposure2012: 0.3 } } : v,
      ),
    });
    const { store, rendered } = await setup({
      photos: [first!, edited(second!), edited(third!)].map((photo, index) =>
        index === 0 ? { ...photo, status: { ...photo.status, edited: false } } : photo,
      ),
    });
    expect(rendered).toHaveLength(0);

    store.selectRelative(1);
    await settle();
    expect(rendered.map((r) => r.photoId)).toEqual([second!.id]);

    // The film strip asks for the ones in view; the throttle spaces them out.
    store.setVisibleEditedPreviews([second!.id, third!.id]);
    await vi.advanceTimersByTimeAsync(400);
    expect(rendered.map((r) => r.photoId)).toEqual([second!.id, third!.id]);
  });

  it('clears the stale flag of a photo that turns out to have no edits', async () => {
    const [first, second] = mockPhotos();
    const { store, rendered } = await setup({
      photos: [
        first!,
        { ...second!, status: { ...second!.status, edited: true }, previewStale: true },
      ],
    });
    store.selectRelative(1);
    await settle();
    expect(rendered).toHaveLength(0);
    expect(store.getState().photos.find((p) => p.id === second!.id)?.previewStale).toBe(false);
  });

  it('renders nothing for an unedited photo and when no renderer is wired', async () => {
    const { store, rendered } = await setup();
    store.setVisibleEditedPreviews(
      store
        .getState()
        .photos.slice(0, 3)
        .map((p) => p.id),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rendered).toHaveLength(0);

    const fake = createFakeBridge();
    const plain = createAppStore(fake.bridge);
    stores.push(plain);
    await plain.init();
    plain.setSlider('Exposure2012', 0.5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.calls.some((call) => call.channel === 'photos:setEditedPreview')).toBe(false);
  });

  it('reports a failing render once, not per photo', async () => {
    const fake = createFakeBridge();
    const store = createAppStore(fake.bridge, {
      renderEditedPreview: async () => {
        throw new Error('no WebGL');
      },
    });
    stores.push(store);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.init();
    store.setSlider('Exposure2012', 0.5);
    await vi.advanceTimersByTimeAsync(800);
    store.selectRelative(1);
    store.setSlider('Exposure2012', 0.5);
    await vi.advanceTimersByTimeAsync(800);
    expect(store.getState().toasts.filter((t) => t.message.includes('no WebGL'))).toHaveLength(1);
  });
});
