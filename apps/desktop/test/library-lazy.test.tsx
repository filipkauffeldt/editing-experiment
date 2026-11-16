import { describe, expect, it } from 'vitest';
import type { Photo, PhotoId } from '@ee/contracts';
import { createAppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

function photo(id: number, folder: string): Photo {
  const path = `/photos/${folder}/_DSC${String(id).padStart(4, '0')}.NEF`;
  return {
    id: `photo-${id}` as PhotoId,
    path,
    sidecarPath: path.replace(/\.NEF$/, '.xmp'),
    fileName: path.slice(path.lastIndexOf('/') + 1),
    captureTime: `2026-05-01T12:${String(id % 60).padStart(2, '0')}:00`,
    sourceId: 'in-place' as Photo['sourceId'],
    tagged: id % 2 === 0,
    colorClass: 0,
    rating: 0,
    status: {
      ingest: 'done',
      edited: false,
      metadataDiffersFromTemplate: false,
      export: 'none',
      upload: 'none',
    },
    versions: [],
  };
}

const folders = ['match-a', 'match-b', 'match-c'];
const photos = Array.from({ length: 2_100 }, (_, index) => photo(index, folders[index % 3]!));

describe('a large Library', () => {
  it('loads the folder tree and one folder instead of every photo', async () => {
    const fake = createFakeBridge({ photos });
    const store = createAppStore(fake.bridge);
    try {
      await store.init();
      const state = store.getState();
      expect(state.lazy).toBe(true);
      expect(state.totalPhotos).toBe(2_100);
      expect(state.folders.map((folder) => [folder.path, folder.count])).toEqual([
        ['/photos/match-a', 700],
        ['/photos/match-b', 700],
        ['/photos/match-c', 700],
      ]);
      // The default Develop view gets a bounded page, not the whole index.
      expect(state.photos).toHaveLength(1_000);
      expect(fake.calls.some((call) => call.channel === 'photos:query')).toBe(true);
      expect(
        fake.calls.some((call) => call.channel === 'photos:list' && call.args[0] === undefined),
      ).toBe(false);

      store.setModule('library');
      await expect.poll(() => store.getState().photos.length).toBe(700);
      expect(new Set(store.getState().photos.map((entry) => entry.path.split('/')[2]))).toEqual(
        new Set(['match-a']),
      );

      store.setLibraryFolder('/photos/match-b');
      await expect
        .poll(() => store.getState().photos.map((entry) => entry.path.split('/')[2])[0])
        .toBe('match-b');
      expect(store.getState().photos).toHaveLength(700);
      expect(store.getState().library.folder).toBe('/photos/match-b');
    } finally {
      await store.dispose();
    }
  });
});
