import { describe, expect, it } from 'vitest';
import type { Photo, PhotoFacets, PhotoId } from '@ee/contracts';
import { createAppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

function photo(index: number, rating: number): Photo {
  const path = `/photos/game/_DSC${String(index).padStart(4, '0')}.NEF`;
  return {
    id: `photo-${index}` as PhotoId,
    path,
    sidecarPath: path.replace(/\.NEF$/, '.xmp'),
    fileName: path.slice(path.lastIndexOf('/') + 1),
    captureTime: `2026-05-01T12:00:0${index}`,
    sourceId: 'in-place' as Photo['sourceId'],
    tagged: false,
    colorClass: 0,
    rating,
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

const facets = (shown: number, scopeTotal: number): PhotoFacets => ({
  shown,
  scopeTotal,
  tag: { all: shown, tagged: 0, untagged: shown },
  status: {
    'not-sent': shown,
    'not-exported': shown,
    exported: 0,
    failed: 0,
    edited: 0,
    'metadata-differs': 0,
  },
  cameras: [],
});

describe('filter counts during a filter change', () => {
  it('drops an answer that was requested for the previous filter', async () => {
    const photos = [photo(1, 5), photo(2, 4), photo(3, 3), photo(4, 1), photo(5, 0)];
    const requests: {
      filter?: { rating?: { mode: string; stars: number } };
      resolve(facets: PhotoFacets): void;
    }[] = [];
    const fake = createFakeBridge({
      photos,
      handlers: {
        'photos:facets': (...args) =>
          new Promise<PhotoFacets>((resolve) => {
            const filter = (
              args[0] as { filter?: { rating?: { mode: string; stars: number } } } | undefined
            )?.filter;
            requests.push({ filter, resolve });
          }),
      },
    });
    const store = createAppStore(fake.bridge, { lazyLibraryPhotos: 0 });
    try {
      await store.init();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]?.filter?.rating).toBeUndefined();

      store.clickRatingStar(3);
      // The first request is still open when the next counts are asked for.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(requests).toHaveLength(1);

      // Its answer arrives after the filter changed: it must not become the count.
      requests[0]!.resolve(facets(5, 5));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.getState().facets).toBeUndefined();

      await expect.poll(() => requests.length).toBe(2);
      expect(requests[1]?.filter?.rating).toEqual({ mode: 'min', stars: 3 });
      requests[1]!.resolve(facets(3, 5));
      await expect.poll(() => store.getState().facets?.shown).toBe(3);
      expect(store.getState().facets?.scopeTotal).toBe(5);
    } finally {
      await store.dispose();
    }
  }, 30_000);
});
