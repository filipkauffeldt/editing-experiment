// @vitest-environment node
import type { IptcFields, PhotoId } from '@ee/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRealStore, waitFor, type RealStore } from './helpers/real-store';

/**
 * Undo and redo of captions and keywords against the real backend: every value is read back from
 * the photo's embedded XMP through the backend's `metadata:read`, so a step that only changed
 * the panel would fail.
 */
describe('undo and redo of metadata', () => {
  let real: RealStore;
  let ids: PhotoId[];

  beforeAll(async () => {
    real = await startRealStore(3);
    ids = real.photos.map((photo) => photo.id);
    real.store.setModule('library');
  }, 60_000);

  afterAll(async () => {
    await real?.dispose();
  }, 60_000);

  const stored = (photoId: PhotoId): Promise<IptcFields> =>
    real.handlers['metadata:read']({ photoId });
  /** Set up what a photo already holds without touching the undo history. */
  const preset = async (photoId: PhotoId, fields: Partial<IptcFields>): Promise<void> => {
    await real.handlers['metadata:write']({ photoId, fields });
  };
  const expectStored = async (photoId: PhotoId, expected: Partial<IptcFields>): Promise<void> => {
    await waitFor('the file to hold the values', async () => {
      const fields = await stored(photoId);
      return Object.entries(expected).every(
        ([name, value]) =>
          JSON.stringify(fields[name as keyof IptcFields] ?? (Array.isArray(value) ? [] : '')) ===
          JSON.stringify(value),
      );
    });
  };
  const toastsAfter = async (act: () => void): Promise<string> => {
    const before = real.store.getState().toasts.length;
    act();
    await waitFor('the toast', () => real.store.getState().toasts.length > before);
    return real.store.getState().toasts.at(-1)!.message;
  };
  /** Open a photo and wait until the panel shows what its file holds, however it was set up. */
  const open = async (photoId: PhotoId): Promise<void> => {
    real.store.select(ids.find((id) => id !== photoId));
    real.store.select(photoId);
    const fields = JSON.stringify(await stored(photoId));
    await waitFor(
      'the metadata to load',
      () => JSON.stringify(real.store.getState().metadata[photoId]) === fields,
    );
  };

  it('undoes everything typed into the caption as one step, and redoes it', async () => {
    await preset(ids[0]!, { caption: 'Before' });
    await open(ids[0]!);
    for (const text of ['Before ', 'Before G', 'Before GA', 'Before GAIS']) {
      real.store.updateMetadataField(ids[0]!, 'caption', text);
    }
    await real.store.saveMetadata(ids[0]!);
    await expectStored(ids[0]!, { caption: 'Before GAIS' });

    expect(await toastsAfter(() => real.store.undoLast())).toBe('Undid caption on game_1.jpg');
    await expectStored(ids[0]!, { caption: 'Before' });
    expect(real.store.getState().metadata[ids[0]!]?.caption).toBe('Before');

    await toastsAfter(() => real.store.redoLast());
    await expectStored(ids[0]!, { caption: 'Before GAIS' });
  });

  it('starts a new step when the field was left, and drops one typed back to where it began', async () => {
    await open(ids[0]!);
    real.store.endMetadataTyping();
    real.store.updateMetadataField(ids[0]!, 'caption', 'Before GAIS wins');
    real.store.endMetadataTyping();
    real.store.updateMetadataField(ids[0]!, 'caption', 'Before GAIS wins 2-0');
    await real.store.saveMetadata(ids[0]!);

    await toastsAfter(() => real.store.undoLast());
    await expectStored(ids[0]!, { caption: 'Before GAIS wins' });
    await toastsAfter(() => real.store.undoLast());
    await expectStored(ids[0]!, { caption: 'Before GAIS' });

    // Typed away and back again: nothing to undo, so the next undo reaches the older step.
    real.store.updateMetadataField(ids[0]!, 'caption', 'Before GAIS x');
    real.store.updateMetadataField(ids[0]!, 'caption', 'Before GAIS');
    await real.store.saveMetadata(ids[0]!);
    await toastsAfter(() => real.store.undoLast());
    await expectStored(ids[0]!, { caption: 'Before' });
  });

  it('undoes each keyword added or removed as its own step', async () => {
    await open(ids[1]!);
    real.store.updateMetadataField(ids[1]!, 'keywords', ['football']);
    real.store.updateMetadataField(ids[1]!, 'keywords', ['football', 'allsvenskan']);
    await real.store.saveMetadata(ids[1]!);
    await expectStored(ids[1]!, { keywords: ['football', 'allsvenskan'] });

    expect(await toastsAfter(() => real.store.undoLast())).toBe('Undid keywords on game_2.jpg');
    await expectStored(ids[1]!, { keywords: ['football'] });
    await toastsAfter(() => real.store.undoLast());
    await expectStored(ids[1]!, { keywords: [] });
    await toastsAfter(() => real.store.redoLast());
    await expectStored(ids[1]!, { keywords: ['football'] });
    await toastsAfter(() => real.store.undoLast());
  });

  it('undoes a batch caption and keywords on every photo it wrote, as one step', async () => {
    await preset(ids[0]!, { caption: 'First', keywords: ['one'] });
    await preset(ids[1]!, { caption: '', keywords: [] });
    await preset(ids[2]!, { caption: 'Third', keywords: ['three', 'shared'] });

    const written = await real.store.applyFieldEdits(ids, [
      { field: 'caption', value: 'Derby', mode: 'replace' },
      { field: 'keywords', value: ['shared', 'derby'], mode: 'append' },
    ]);
    expect(written).toBe(3);
    await expectStored(ids[0]!, { caption: 'Derby', keywords: ['one', 'shared', 'derby'] });
    await expectStored(ids[1]!, { caption: 'Derby', keywords: ['shared', 'derby'] });
    await expectStored(ids[2]!, { caption: 'Derby', keywords: ['three', 'shared', 'derby'] });

    expect(await toastsAfter(() => real.store.undoLast())).toBe(
      'Undid caption and keywords on 3 photos',
    );
    await expectStored(ids[0]!, { caption: 'First', keywords: ['one'] });
    await expectStored(ids[1]!, { caption: '', keywords: [] });
    await expectStored(ids[2]!, { caption: 'Third', keywords: ['three', 'shared'] });

    await toastsAfter(() => real.store.redoLast());
    await expectStored(ids[1]!, { caption: 'Derby', keywords: ['shared', 'derby'] });
    await toastsAfter(() => real.store.undoLast());
    await expectStored(ids[1]!, { caption: '', keywords: [] });
  });

  it('undoes pasted metadata, including the fields it cleared', async () => {
    await preset(ids[0]!, { caption: 'Source caption', byline: 'Anna Berg', keywords: ['src'] });
    await preset(ids[1]!, { caption: 'Old caption', byline: 'Old byline', keywords: ['a', 'b'] });
    await preset(ids[2]!, { caption: '', byline: '', keywords: [] });
    await open(ids[0]!);
    real.store.openMetadataCopy();
    real.store.confirmMetadataCopy(['caption', 'byline', 'keywords']);
    real.store.select(ids[1]);
    real.store.select(ids[2], 'toggle');
    await real.store.pasteMetadata();
    await expectStored(ids[1]!, {
      caption: 'Source caption',
      byline: 'Anna Berg',
      keywords: ['src'],
    });
    await expectStored(ids[2]!, {
      caption: 'Source caption',
      byline: 'Anna Berg',
      keywords: ['src'],
    });

    expect(await toastsAfter(() => real.store.undoLast())).toBe('Undid metadata on 2 photos');
    await expectStored(ids[1]!, {
      caption: 'Old caption',
      byline: 'Old byline',
      keywords: ['a', 'b'],
    });
    await expectStored(ids[2]!, { caption: '', byline: '', keywords: [] });
  });

  it('undoes whichever of a label and a caption changed last, across modules', async () => {
    await open(ids[2]!);
    real.store.updateMetadataField(ids[2]!, 'caption', 'Late goal');
    real.store.endMetadataTyping();
    real.store.setRating(5);

    expect(await toastsAfter(() => real.store.undoLast())).toBe('Undid rating on game_3.jpg');
    expect(await toastsAfter(() => real.store.undoLast())).toBe('Undid caption on game_3.jpg');
    await expectStored(ids[2]!, { caption: '' });
    expect(await toastsAfter(() => real.store.redoLast())).toBe('Redid caption on game_3.jpg');
    expect(await toastsAfter(() => real.store.redoLast())).toBe('Redid rating on game_3.jpg');
    await expectStored(ids[2]!, { caption: 'Late goal' });
  });
});
