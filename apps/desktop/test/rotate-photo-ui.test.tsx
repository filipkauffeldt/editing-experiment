import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EditParams, Photo, PhotoId, RotatePhotosArgs } from '@ee/contracts';
import {
  composeOrientation,
  cropOrientedToStored,
  cropStoredToOriented,
  normalizeTurns,
} from '@ee/develop-gl/crop';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { activePhoto, createAppStore, paramsForPhoto, type AppStore } from '../src/renderer/store';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const CROP = { left: 0.1, top: 0.2, right: 0.5, bottom: 0.9, angle: 0 };

/**
 * The backend as far as the renderer can tell: the photo comes back turned and its develop
 * crop is the one the stored (sensor space) crop gives in the turned picture, which the backend
 * tests prove against real files.
 */
function turningBackend(photos: Photo[]) {
  const developOf = (photoId: PhotoId): EditParams => {
    const version = photos
      .find((candidate) => candidate.id === photoId)
      ?.versions.find((candidate) => candidate.kind === 'develop');
    return version?.kind === 'develop' ? version.ops : {};
  };
  return {
    // The sidecar: what the renderer saved is what a rotation reads and turns.
    'develop:getParams': async (...args: unknown[]) =>
      developOf((args[0] as { photoId: PhotoId }).photoId),
    'develop:setParams': async (...args: unknown[]) => {
      const { photoId, params } = args[0] as { photoId: PhotoId; params: EditParams };
      const photo = photos.find((candidate) => candidate.id === photoId);
      if (photo) {
        photo.versions = photo.versions.map((version) =>
          version.kind === 'develop' ? { ...version, ops: params } : version,
        );
      }
    },
    'photos:rotate': async (...args: unknown[]) => {
      const { photoIds, turns } = args[0] as RotatePhotosArgs;
      const updated: Photo[] = [];
      for (const photoId of photoIds) {
        const photo = photos.find((candidate) => candidate.id === photoId);
        if (!photo?.width || !photo.height) continue;
        const camera = photo.orientation ?? 1;
        const before = normalizeTurns(photo.rotation ?? 0);
        const after = normalizeTurns(before + turns);
        const oldSize = { width: photo.width, height: photo.height };
        const newSize = turns % 2 === 0 ? oldSize : { width: photo.height, height: photo.width };
        const versions = photo.versions.map((version) => {
          if (version.kind !== 'develop' || version.ops.crop === undefined) return version;
          const stored = cropOrientedToStored(
            version.ops.crop,
            oldSize,
            composeOrientation(camera, before),
          );
          const crop = cropStoredToOriented(stored, newSize, composeOrientation(camera, after));
          return { ...version, ops: { ...version.ops, crop } };
        });
        const next: Photo = {
          ...photo,
          ...newSize,
          versions,
          previewRevision: (photo.previewRevision ?? 0) + 1,
        };
        delete next.rotation;
        if (after !== 0) next.rotation = after;
        photos.splice(photos.indexOf(photo), 1, next);
        updated.push(next);
      }
      return { updated, failed: [] };
    },
  };
}

function croppedPhotos(): Photo[] {
  return mockPhotos().map((photo, index) =>
    index === 0
      ? {
          ...photo,
          width: 6000,
          height: 4000,
          orientation: 1,
          versions: photo.versions.map((version) =>
            version.kind === 'develop'
              ? { ...version, ops: { ...version.ops, crop: CROP } }
              : version,
          ),
        }
      : photo,
  );
}

async function renderApp(
  photos: Photo[] = croppedPhotos(),
): Promise<{ store: AppStore; fake: FakeBridge; photos: Photo[] }> {
  const fake = createFakeBridge({ photos, handlers: turningBackend(photos) });
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  return { store, fake, photos };
}

const key = (init: KeyboardEventInit): void => {
  act(() => {
    fireEvent.keyDown(window, init);
  });
};
const rotateCalls = (fake: FakeBridge): RotatePhotosArgs[] =>
  fake.calls
    .filter((call) => call.channel === 'photos:rotate')
    .map((call) => call.args[0] as RotatePhotosArgs);

const openPhoto = (store: AppStore): Photo => {
  const photo = activePhoto(store.getState());
  if (!photo) throw new Error('no open photo');
  return photo;
};
const crop = (store: AppStore): EditParams['crop'] =>
  paramsForPhoto(store.getState(), openPhoto(store)).crop;

describe('turning the open photo in Develop', () => {
  it('turns right on Ctrl/⌘ + → and left on Ctrl/⌘ + ←', async () => {
    const { store, fake } = await renderApp();
    const id = openPhoto(store).id;

    key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
    await waitFor(() => expect(openPhoto(store).rotation).toBe(1));
    expect(rotateCalls(fake)).toEqual([{ photoIds: [id], turns: 1 }]);
    expect(openPhoto(store)).toMatchObject({ width: 4000, height: 6000 });

    key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true });
    await waitFor(() => expect(openPhoto(store).rotation).toBeUndefined());
    expect(rotateCalls(fake).at(-1)).toEqual({ photoIds: [id], turns: -1 });
    expect(openPhoto(store)).toMatchObject({ width: 6000, height: 4000 });
  });

  it('leaves the arrow keys without Ctrl/⌘, with Shift, and with AltGr alone for the photo list', async () => {
    const { store, fake } = await renderApp();
    const first = openPhoto(store).id;

    key({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(openPhoto(store).id).not.toBe(first);
    key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, shiftKey: true });
    key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true });
    key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true });
    expect(rotateCalls(fake)).toEqual([]);
  });

  it('does not turn while a caption is being typed, and turns once for a held key', async () => {
    const { store, fake } = await renderApp();
    const caption = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
    expect(caption).not.toBeNull();
    caption!.focus();
    fireEvent.keyDown(caption!, { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
    expect(rotateCalls(fake)).toEqual([]);
    caption!.blur();

    key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
    key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, repeat: true });
    await waitFor(() => expect(openPhoto(store).rotation).toBe(1));
    expect(rotateCalls(fake)).toHaveLength(1);
  });

  it('keeps the crop on the same picture content and undoes and redoes the turn', async () => {
    const { store, fake } = await renderApp();
    expect(crop(store)).toMatchObject(CROP);

    await store.rotatePhotos(1);

    // The crop box of the landscape picture is the same area of a portrait one: x' = 1 - y, y' = x.
    expect(crop(store)?.left).toBeCloseTo(0.1, 9);
    expect(crop(store)?.top).toBeCloseTo(0.1, 9);
    expect(crop(store)?.right).toBeCloseTo(0.8, 9);
    expect(crop(store)?.bottom).toBeCloseTo(0.5, 9);
    // Nothing is saved for it: the sidecar's crop is in sensor space and did not move.
    expect(fake.calls.filter((call) => call.channel === 'develop:setParams')).toEqual([]);
    expect(store.canUndoDevelop()).toBe(true);

    expect(store.undoDevelop()).toBe(true);
    await waitFor(() => expect(openPhoto(store).rotation).toBeUndefined());
    expect(rotateCalls(fake).at(-1)?.turns).toBe(-1);
    expect(openPhoto(store)).toMatchObject({ width: 6000, height: 4000 });
    expect(crop(store)?.left).toBeCloseTo(0.1, 9);
    expect(crop(store)?.top).toBeCloseTo(0.2, 9);
    expect(crop(store)?.right).toBeCloseTo(0.5, 9);
    expect(crop(store)?.bottom).toBeCloseTo(0.9, 9);
    expect(store.canUndoDevelop()).toBe(false);
    expect(store.canRedoDevelop()).toBe(true);

    expect(store.redoDevelop()).toBe(true);
    await waitFor(() => expect(openPhoto(store).rotation).toBe(1));
    expect(rotateCalls(fake).at(-1)?.turns).toBe(1);
    expect(crop(store)?.right).toBeCloseTo(0.8, 9);
  });

  it('puts a turn among the other steps in the order they were made', async () => {
    const { store } = await renderApp();

    store.setSlider('Exposure2012', 0.4);
    await store.rotatePhotos(1);
    store.setSlider('Contrast2012', 12);

    expect(store.undoDevelop()).toBe(true);
    expect(paramsForPhoto(store.getState(), openPhoto(store))).toMatchObject({ Exposure2012: 0.4 });
    expect(paramsForPhoto(store.getState(), openPhoto(store)).Contrast2012).toBeUndefined();
    expect(openPhoto(store).rotation).toBe(1);

    expect(store.undoDevelop()).toBe(true);
    await waitFor(() => expect(openPhoto(store).rotation).toBeUndefined());
    expect(paramsForPhoto(store.getState(), openPhoto(store)).Exposure2012).toBe(0.4);
    expect(store.undoDevelop()).toBe(true);
    expect(paramsForPhoto(store.getState(), openPhoto(store)).Exposure2012).toBeUndefined();
  });

  it('is not offered in a crop session', async () => {
    const { store, fake } = await renderApp();
    store.toggleCrop();
    expect(store.getState().crop).toBeDefined();

    key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
    await store.rotatePhotos(1);

    expect(rotateCalls(fake)).toEqual([]);
  });
});

describe('turning from the Library and the photo menu', () => {
  it('turns every selected photo with one call', async () => {
    const { store, fake } = await renderApp();
    await userEvent.setup().keyboard('g');
    await screen.findByTestId('library-grid');
    key({ key: 'a', code: 'KeyA', ctrlKey: true });
    const selected = [...store.getState().selection];
    expect(selected.length).toBeGreaterThan(2);

    key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true });

    await waitFor(() => expect(rotateCalls(fake)).toHaveLength(1));
    expect(rotateCalls(fake)[0]).toEqual({ photoIds: selected, turns: -1 });
  });

  it('has Rotate left and Rotate right in the right-click menu, acting on the selection', async () => {
    const { store, fake } = await renderApp();
    await userEvent.setup().keyboard('g');
    const cells = await screen.findAllByTestId('library-cell');
    fireEvent.click(cells[1]!);
    fireEvent.click(cells[2]!, { ctrlKey: true });
    const selected = [...store.getState().selection];
    expect(selected).toHaveLength(2);

    fireEvent.contextMenu(cells[2]!, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByTestId('photo-menu-rotate-right'));

    await waitFor(() => expect(rotateCalls(fake)).toHaveLength(1));
    expect(rotateCalls(fake)[0]).toEqual({ photoIds: selected, turns: 1 });
    expect(store.getState().photoMenu).toBeUndefined();
  });

  it('has the buttons in Develop too', async () => {
    const { store, fake } = await renderApp();
    const id: PhotoId = openPhoto(store).id;

    fireEvent.click(await screen.findByTestId('rotate-left'));

    await waitFor(() => expect(rotateCalls(fake)).toHaveLength(1));
    expect(rotateCalls(fake)[0]).toEqual({ photoIds: [id], turns: -1 });
  });
});
