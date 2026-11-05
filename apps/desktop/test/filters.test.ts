import { asPhotoId, asSourceId, type Photo } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  cameraKey,
  filterCounts,
  filterPhotos,
  initialFilter,
  isFiltering,
  matchesFilter,
  toggleInList,
  toggleMinRating,
  type FilterState,
} from '../src/renderer/filters';

let sequence = 0;
function photo(overrides: Omit<Partial<Photo>, 'status'> & { status?: Partial<Photo['status']> } = {}): Photo {
  sequence += 1;
  const { status, ...rest } = overrides;
  return {
    id: asPhotoId(`p${sequence}`),
    path: `/photos/IMG_${sequence}.NEF`,
    sidecarPath: `/photos/IMG_${sequence}.xmp`,
    fileName: `IMG_${sequence}.NEF`,
    sourceId: asSourceId('card'),
    tagged: false,
    colorClass: 0,
    rating: 0,
    versions: [],
    status: {
      ingest: 'done',
      edited: false,
      metadataDiffersFromTemplate: false,
      export: 'none',
      upload: 'none',
      ...status,
    },
    ...rest,
  };
}

const withFilter = (patch: Partial<FilterState>): FilterState => ({ ...initialFilter(), ...patch });
const ids = (photos: Photo[]): string[] => photos.map((p) => p.id);

describe('filters', () => {
  it('shows everything when nothing is on', () => {
    const all = [photo(), photo({ tagged: true }), photo({ rating: 3 })];
    expect(filterPhotos(all, initialFilter())).toEqual(all);
    expect(isFiltering(initialFilter())).toBe(false);
  });

  describe('tag', () => {
    const tagged = photo({ tagged: true });
    const untagged = photo();
    it('splits tagged from untagged', () => {
      expect(filterPhotos([tagged, untagged], withFilter({ tag: 'tagged' }))).toEqual([tagged]);
      expect(filterPhotos([tagged, untagged], withFilter({ tag: 'untagged' }))).toEqual([untagged]);
    });
  });

  describe('rating "N and up"', () => {
    const none = photo({ rating: 0 });
    const two = photo({ rating: 2 });
    const three = photo({ rating: 3 });
    const five = photo({ rating: 5 });
    const all = [none, two, three, five];

    it('keeps N stars and more, and drops unrated photos', () => {
      expect(ids(filterPhotos(all, withFilter({ minRating: 3 })))).toEqual([three.id, five.id]);
      expect(ids(filterPhotos(all, withFilter({ minRating: 1 })))).toEqual([
        two.id,
        three.id,
        five.id,
      ]);
      expect(ids(filterPhotos(all, withFilter({ minRating: 5 })))).toEqual([five.id]);
    });

    it('sets the filter on a click and clears it on a click on the active star', () => {
      expect(toggleMinRating(0, 3)).toBe(3);
      expect(toggleMinRating(3, 4)).toBe(4);
      expect(toggleMinRating(3, 3)).toBe(0);
      expect(isFiltering(withFilter({ minRating: 3 }))).toBe(true);
    });
  });

  describe('colour', () => {
    const red = photo({ colorClass: 1 });
    const yellow = photo({ colorClass: 3 });
    const blue = photo({ colorClass: 5 });
    const plain = photo({ colorClass: 0 });
    const all = [red, yellow, blue, plain];

    it('shows several classes at once', () => {
      expect(ids(filterPhotos(all, withFilter({ colorClasses: [1, 5] })))).toEqual([
        red.id,
        blue.id,
      ]);
      expect(ids(filterPhotos(all, withFilter({ colorClasses: [3] })))).toEqual([yellow.id]);
    });

    it('toggles classes in and out of the list', () => {
      expect(toggleInList([1], 5)).toEqual([1, 5]);
      expect(toggleInList([1, 5], 1)).toEqual([5]);
    });
  });

  describe('status', () => {
    const sent = photo({ status: { upload: 'done' } });
    const failed = photo({ status: { upload: 'failed' } });
    const queued = photo({ status: { upload: 'queued' } });
    const edited = photo({ status: { edited: true } });
    const retouched = photo({
      versions: [{ id: 'v' as never, kind: 'retouch', ops: [] as never }],
    });
    const differs = photo({ status: { metadataDiffersFromTemplate: true } });
    const all = [sent, failed, queued, edited, retouched, differs];

    it('not sent is everything that has not been uploaded, failed ones included', () => {
      expect(ids(filterPhotos(all, withFilter({ statuses: ['not-sent'] })))).toEqual(
        ids(all.filter((p) => p !== sent)),
      );
    });

    it('failed, edited (retouch counts) and metadata differs', () => {
      expect(ids(filterPhotos(all, withFilter({ statuses: ['failed'] })))).toEqual([failed.id]);
      expect(ids(filterPhotos(all, withFilter({ statuses: ['edited'] })))).toEqual([
        edited.id,
        retouched.id,
      ]);
      expect(ids(filterPhotos(all, withFilter({ statuses: ['metadata-differs'] })))).toEqual([
        differs.id,
      ]);
    });

    it('needs every ticked status', () => {
      const editedAndSent = photo({ status: { edited: true, upload: 'done' } });
      const both = [edited, editedAndSent, sent];
      expect(ids(filterPhotos(both, withFilter({ statuses: ['edited', 'not-sent'] })))).toEqual([
        edited.id,
      ]);
      expect(ids(filterPhotos(both, withFilter({ statuses: ['edited'] })))).toEqual([
        edited.id,
        editedAndSent.id,
      ]);
    });
  });

  describe('camera and source', () => {
    const z6 = { make: 'NIKON', model: 'Z 6', serialNumber: '111' };
    const z9 = { make: 'NIKON', model: 'Z 9', serialNumber: '222' };
    const a = photo({ camera: z6, sourceId: asSourceId('card-a') });
    const b = photo({ camera: z9, sourceId: asSourceId('card-a') });
    const c = photo({ camera: z6, sourceId: asSourceId('ftp') });
    const all = [a, b, c];

    it('filters by body, by source, and by both together', () => {
      expect(ids(filterPhotos(all, withFilter({ camera: cameraKey(a) })))).toEqual([a.id, c.id]);
      expect(ids(filterPhotos(all, withFilter({ sourceId: asSourceId('card-a') })))).toEqual([
        a.id,
        b.id,
      ]);
      expect(
        ids(filterPhotos(all, withFilter({ camera: cameraKey(a), sourceId: asSourceId('ftp') }))),
      ).toEqual([c.id]);
    });
  });

  describe('search', () => {
    const a = photo();
    const b = photo();
    it('keeps the photos the search found', () => {
      const found = new Set([b.id]);
      expect(filterPhotos([a, b], withFilter({ search: 'åkerlund' }), found)).toEqual([b]);
    });

    it('does not restrict while no result is known, or when the text is blank', () => {
      expect(filterPhotos([a, b], withFilter({ search: 'x' }), undefined)).toEqual([a, b]);
      expect(filterPhotos([a, b], withFilter({ search: '   ' }), new Set())).toEqual([a, b]);
      expect(isFiltering(withFilter({ search: '  ' }))).toBe(false);
      expect(isFiltering(withFilter({ search: 'x' }))).toBe(true);
    });
  });

  describe('combinations', () => {
    const wanted = photo({
      tagged: true,
      rating: 4,
      colorClass: 2,
      camera: { make: 'NIKON', model: 'Z 9', serialNumber: '222' },
      sourceId: asSourceId('card-a'),
      status: { edited: true },
    });
    // Each variant is `wanted` with one thing different, and its own id.
    let variants = 0;
    const variant = (patch: Partial<Photo>): Photo => {
      variants += 1;
      return { ...wanted, id: asPhotoId(`variant-${variants}`), ...patch };
    };
    const wrongRating = variant({ rating: 2 });
    const wrongColour = variant({ colorClass: 4 });
    const wrongTag = variant({ tagged: false });
    const wrongCamera = variant({ camera: { make: 'NIKON', model: 'Z 6' } });
    const wrongSource = variant({ sourceId: asSourceId('ftp') });
    const wrongStatus = variant({ status: { ...wanted.status, edited: false } });
    const notFound = variant({});
    const all = [
      wanted,
      wrongRating,
      wrongColour,
      wrongTag,
      wrongCamera,
      wrongSource,
      wrongStatus,
      notFound,
    ];
    const filter = withFilter({
      tag: 'tagged',
      minRating: 3,
      colorClasses: [2, 6],
      statuses: ['edited'],
      camera: cameraKey(wanted),
      sourceId: asSourceId('card-a'),
      search: 'goal',
    });
    const found = new Set(all.filter((p) => p !== notFound).map((p) => p.id));

    it('applies every filter at once, and each one on its own removes its photo', () => {
      expect(ids(filterPhotos(all, filter, found))).toEqual([wanted.id]);
      for (const [wrong, relax] of [
        [wrongRating, { minRating: 0 }],
        [wrongColour, { colorClasses: [] }],
        [wrongTag, { tag: 'all' as const }],
        [wrongCamera, { camera: undefined }],
        [wrongSource, { sourceId: undefined }],
        [wrongStatus, { statuses: [] }],
        [notFound, { search: '' }],
      ] as const) {
        expect(matchesFilter(wrong, filter, found)).toBe(false);
        expect(matchesFilter(wrong, { ...filter, ...relax }, found)).toBe(true);
      }
    });
  });

  describe('counts', () => {
    const a = photo({ tagged: true, rating: 4, status: { upload: 'done' } });
    const b = photo({ tagged: true, rating: 2, status: { edited: true } });
    const c = photo({ rating: 4, status: { edited: true, upload: 'failed' } });
    const d = photo({ rating: 0 });
    const all = [a, b, c, d];

    it('counts each option against the rest of the filter', () => {
      const none = filterCounts(all, initialFilter());
      expect(none.tag).toEqual({ all: 4, tagged: 2, untagged: 2 });
      expect(none.status).toEqual({
        'not-sent': 3,
        failed: 1,
        edited: 2,
        'metadata-differs': 0,
      });
      expect(none.shown).toBe(4);

      const rated = filterCounts(all, withFilter({ minRating: 3 }));
      expect(rated.tag).toEqual({ all: 2, tagged: 1, untagged: 1 });
      expect(rated.status['not-sent']).toBe(1);
      expect(rated.shown).toBe(2);
    });

    it('keeps the tag counts when a tag is picked, and the status counts follow the tag', () => {
      const tagged = filterCounts(all, withFilter({ tag: 'tagged' }));
      expect(tagged.tag).toEqual({ all: 4, tagged: 2, untagged: 2 });
      expect(tagged.status.edited).toBe(1);
      expect(tagged.shown).toBe(2);
    });

    it('counts a status as what ticking it would show with the others still ticked', () => {
      const counts = filterCounts(all, withFilter({ statuses: ['edited'] }));
      expect(counts.status.edited).toBe(2);
      expect(counts.status['not-sent']).toBe(2);
      expect(counts.status.failed).toBe(1);
      expect(counts.tag).toEqual({ all: 2, tagged: 1, untagged: 1 });
      expect(counts.shown).toBe(2);
    });

    it('matches the length of the filtered list', () => {
      const filter = withFilter({ tag: 'untagged', statuses: ['not-sent'], minRating: 1 });
      expect(filterCounts(all, filter).shown).toBe(filterPhotos(all, filter).length);
    });
  });
});
