// @vitest-environment node
import type { PhotoId } from '@ee/contracts';
import { ExifToolService } from '@ee/metadata';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startRealStore, waitFor, type RealStore } from './helpers/real-store';

/**
 * A turn is a step of the develop history, and Ctrl/Cmd+Z takes the newest change of the develop
 * and the label histories: after "rate, then turn" the turn goes first. Against the real backend,
 * so the sidecar and the index have to agree with the screen.
 */
describe('undo and redo of a turn among label changes', () => {
  let real: RealStore;
  let id: PhotoId;
  const exiftool = new ExifToolService();

  beforeAll(async () => {
    real = await startRealStore(1);
    id = real.photos[0]!.id;
    real.store.setModule('develop');
    real.store.select(id);
  }, 60_000);

  afterAll(async () => {
    await real?.dispose();
    await exiftool.close();
  }, 60_000);

  const shown = () => real.store.getState().photos.find((photo) => photo.id === id)!;
  const onDisk = async () => {
    const photo = await real.handlers['photos:get']({ photoId: id });
    const tags = await exiftool.read(photo.path);
    return {
      rotation: photo.rotation,
      orientation: tags['XMP-tiff:Orientation'],
      rating: photo.rating,
    };
  };
  /** The screen, the index and the file agree on the turn and the rating. */
  const expectState = async (rotation: number | undefined, rating: number) => {
    await waitFor('the turn and the rating to settle', async () => {
      const disk = await onDisk();
      return (
        shown().rotation === rotation &&
        shown().rating === rating &&
        disk.rotation === rotation &&
        disk.rating === rating &&
        disk.orientation === (rotation === undefined ? undefined : 6)
      );
    });
  };

  it('undoes the turn before the rating that came first, and redoes them in order', async () => {
    real.store.setRating(3);
    await expectState(undefined, 3);
    await real.store.rotatePhotos(1);
    await expectState(1, 3);

    real.store.undoLast();
    await expectState(undefined, 3);

    real.store.undoLast();
    await expectState(undefined, 0);

    real.store.redoLast();
    await expectState(undefined, 3);

    real.store.redoLast();
    await expectState(1, 3);
  });

  it('puts a rating made while the turn was still being written after it', async () => {
    real.store.undoLast();
    await expectState(undefined, 3);
    real.store.undoLast();
    await expectState(undefined, 0);

    // The turn is asked for first, the rating next, and the backend answers the turn last.
    const turning = real.store.rotatePhotos(1);
    real.store.setRating(5);
    await turning;
    await expectState(1, 5);

    real.store.undoLast();
    await expectState(1, 0);
    real.store.undoLast();
    await expectState(undefined, 0);
  });
});
