// @vitest-environment node
import type { Photo, PhotoId } from '@ee/contracts';
import { ExifToolService, readPhotoLabels } from '@ee/metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRealStore, waitFor, type RealStore } from './helpers/real-store';

/**
 * Undo and redo of tags, ratings and colour labels against the real backend: the values are read
 * back from the index and from each photo's embedded XMP, so an undo that only changed the
 * screen would fail here.
 */
describe('undo and redo of labels', () => {
  let real: RealStore;
  let ids: PhotoId[];
  const exiftool = new ExifToolService();

  beforeAll(async () => {
    real = await startRealStore(3);
    ids = real.photos.map((photo) => photo.id);
    real.store.setModule('library');
  }, 60_000);

  afterAll(async () => {
    await real?.dispose();
    await exiftool.close();
  }, 60_000);

  const indexed = (photoId: PhotoId): Promise<Photo> => real.handlers['photos:get']({ photoId });
  const onDisk = async (photoId: PhotoId) =>
    readPhotoLabels((await indexed(photoId)).path, { service: exiftool });
  const labelsOf = async (photoId: PhotoId) => {
    const photo = await indexed(photoId);
    return { tagged: photo.tagged, colorClass: photo.colorClass, rating: photo.rating };
  };
  /** The state the grid shows, the index and the file, which must all agree. */
  const everywhere = async (photoId: PhotoId) => {
    const shown = real.store.getState().photos.find((photo) => photo.id === photoId);
    const { tagged, colorClass, rating } = await onDisk(photoId);
    return {
      shown: { tagged: shown?.tagged, colorClass: shown?.colorClass, rating: shown?.rating },
      index: await labelsOf(photoId),
      file: { tagged, colorClass, rating },
    };
  };
  const expectLabels = async (
    photoId: PhotoId,
    expected: { tagged: boolean; colorClass: number; rating: number },
  ) => {
    // The step resolves once its writes are done; the store settles a tick later.
    await waitFor('labels to settle', async () => {
      const seen = await everywhere(photoId);
      return (
        JSON.stringify(seen.shown) === JSON.stringify(expected) &&
        JSON.stringify(seen.index) === JSON.stringify(expected) &&
        JSON.stringify(seen.file) === JSON.stringify(expected)
      );
    });
  };
  const selectAll = (): void => {
    real.store.select(ids[0]);
    for (const id of ids.slice(1)) real.store.select(id, 'toggle');
  };
  /** Wait for the undo or redo to be written: the toast is added after its writes. */
  const toastsAfter = async (act: () => void): Promise<string> => {
    const before = real.store.getState().toasts.length;
    act();
    await waitFor('the toast', () => real.store.getState().toasts.length > before);
    return real.store.getState().toasts.at(-1)!.message;
  };

  it('undoes and redoes a rating of one photo, in the file as well', async () => {
    real.store.select(ids[0]);
    real.store.setRating(4);
    await expectLabels(ids[0]!, { tagged: false, colorClass: 0, rating: 4 });

    const undone = await toastsAfter(() => real.store.undoLast());
    expect(undone).toBe('Undid rating on game_1.jpg');
    await expectLabels(ids[0]!, { tagged: false, colorClass: 0, rating: 0 });

    const redone = await toastsAfter(() => real.store.redoLast());
    expect(redone).toBe('Redid rating on game_1.jpg');
    await expectLabels(ids[0]!, { tagged: false, colorClass: 0, rating: 4 });

    await toastsAfter(() => real.store.undoLast());
    await expectLabels(ids[0]!, { tagged: false, colorClass: 0, rating: 0 });
  });

  it('undoes a batch colour label as one step that restores every old value', async () => {
    // Different old colours, so the undo can not be "set all to one value".
    real.store.select(ids[0]);
    real.store.setColorClass(2);
    real.store.select(ids[1]);
    real.store.setColorClass(5);
    await expectLabels(ids[1]!, { tagged: false, colorClass: 5, rating: 0 });

    selectAll();
    real.store.setColorClass(7);
    for (const id of ids) await expectLabels(id, { tagged: false, colorClass: 7, rating: 0 });

    const message = await toastsAfter(() => real.store.undoLast());
    expect(message).toBe('Undid colour label on 3 photos');
    await expectLabels(ids[0]!, { tagged: false, colorClass: 2, rating: 0 });
    await expectLabels(ids[1]!, { tagged: false, colorClass: 5, rating: 0 });
    await expectLabels(ids[2]!, { tagged: false, colorClass: 0, rating: 0 });

    await toastsAfter(() => real.store.redoLast());
    for (const id of ids) await expectLabels(id, { tagged: false, colorClass: 7, rating: 0 });

    // The earlier single changes are still on the stack below the batch.
    await toastsAfter(() => real.store.undoLast());
    await toastsAfter(() => real.store.undoLast());
    await expectLabels(ids[1]!, { tagged: false, colorClass: 0, rating: 0 });
    await toastsAfter(() => real.store.undoLast());
    await expectLabels(ids[0]!, { tagged: false, colorClass: 0, rating: 0 });
  });

  it('undoes a tag toggle on a mixed selection back to each photo', async () => {
    real.store.select(ids[1]);
    real.store.toggleTag();
    await expectLabels(ids[1]!, { tagged: true, colorClass: 0, rating: 0 });

    selectAll();
    real.store.toggleTag();
    // Not all were tagged: everything is tagged now.
    for (const id of ids) await expectLabels(id, { tagged: true, colorClass: 0, rating: 0 });

    expect(await toastsAfter(() => real.store.undoLast())).toBe('Undid tag on 3 photos');
    await expectLabels(ids[0]!, { tagged: false, colorClass: 0, rating: 0 });
    await expectLabels(ids[1]!, { tagged: true, colorClass: 0, rating: 0 });
    await expectLabels(ids[2]!, { tagged: false, colorClass: 0, rating: 0 });

    await toastsAfter(() => real.store.undoLast());
    await expectLabels(ids[1]!, { tagged: false, colorClass: 0, rating: 0 });
  });

  it('takes steps back newest first and drops the redo steps after a new change', async () => {
    real.store.select(ids[2]);
    real.store.setRating(3);
    real.store.setColorClass(1);
    await expectLabels(ids[2]!, { tagged: false, colorClass: 1, rating: 3 });

    await toastsAfter(() => real.store.undoLast());
    await expectLabels(ids[2]!, { tagged: false, colorClass: 0, rating: 3 });

    // A new change after an undo ends the redo line.
    real.store.setRating(5);
    await expectLabels(ids[2]!, { tagged: false, colorClass: 0, rating: 5 });
    const calls = real.store.getState().toasts.length;
    real.store.redoLast();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(real.store.getState().toasts.length).toBe(calls);
    await expectLabels(ids[2]!, { tagged: false, colorClass: 0, rating: 5 });

    await toastsAfter(() => real.store.undoLast());
    await expectLabels(ids[2]!, { tagged: false, colorClass: 0, rating: 3 });
    await toastsAfter(() => real.store.undoLast());
    await expectLabels(ids[2]!, { tagged: false, colorClass: 0, rating: 0 });
  });
});
