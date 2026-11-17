import { asPhotoId, asSourceId, type Photo } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  cameraKey,
  colorFilterState,
  cycleColorClass,
  filterCounts,
  filterPhotos,
  initialFilter,
  isFiltering,
  matchesFilter,
  toggleInList,
  clickRatingStar,
  pickRatingMode,
  ratingFilter,
  type FilterState,
} from '../src/renderer/filters';

let sequence = 0;
function photo(
  overrides: Omit<Partial<Photo>, 'status'> & { status?: Partial<Photo['status']> } = {},
): Photo {
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
      expect(ids(filterPhotos(all, withFilter({ ratingStars: 3 })))).toEqual([three.id, five.id]);
      expect(ids(filterPhotos(all, withFilter({ ratingStars: 1 })))).toEqual([
        two.id,
        three.id,
        five.id,
      ]);
      expect(ids(filterPhotos(all, withFilter({ ratingStars: 5 })))).toEqual([five.id]);
    });

    it('sets the filter on a click and clears it on a click on the active star', () => {
      const off = withFilter({});
      const three = withFilter(clickRatingStar(off, 3));
      expect(three).toMatchObject({ ratingStars: 3, ratingMode: 'min' });
      expect(withFilter(clickRatingStar(three, 4)).ratingStars).toBe(4);
      expect(withFilter(clickRatingStar(three, 3)).ratingStars).toBe(0);
      expect(isFiltering(withFilter({ ratingStars: 3 }))).toBe(true);
    });
  });

  describe('rating modes', () => {
    const unrated = photo({ rating: 0 });
    const one = photo({ rating: 1 });
    const three = photo({ rating: 3 });
    const four = photo({ rating: 4 });
    const five = photo({ rating: 5 });
    const all = [unrated, one, three, four, five];
    const rated = (ratingMode: FilterState['ratingMode'], ratingStars: number): string[] =>
      ids(filterPhotos(all, withFilter({ ratingMode, ratingStars })));

    it('and up is the default and keeps N stars and more', () => {
      expect(initialFilter().ratingMode).toBe('min');
      expect(rated('min', 3)).toEqual([three.id, four.id, five.id]);
    });

    it('exactly keeps only that many stars', () => {
      expect(rated('exact', 3)).toEqual([three.id]);
      expect(rated('exact', 2)).toEqual([]);
    });

    it('at most keeps that many stars or fewer, unrated photos included', () => {
      expect(rated('max', 3)).toEqual([unrated.id, one.id, three.id]);
      expect(rated('max', 1)).toEqual([unrated.id, one.id]);
    });

    it('unrated keeps only photos with no rating and ignores the stars', () => {
      expect(rated('unrated', 0)).toEqual([unrated.id]);
      expect(rated('unrated', 4)).toEqual([unrated.id]);
      expect(ratingFilter(withFilter({ ratingMode: 'unrated' }))).toEqual({
        mode: 'exact',
        stars: 0,
      });
    });

    it('is off with no star picked, whatever the mode', () => {
      for (const mode of ['min', 'exact', 'max'] as const) {
        expect(rated(mode, 0)).toEqual(ids(all));
        expect(isFiltering(withFilter({ ratingMode: mode }))).toBe(false);
      }
      expect(isFiltering(withFilter({ ratingMode: 'unrated' }))).toBe(true);
    });

    it('keeps the star when the mode changes, and clears it on a click on the active star', () => {
      const exact = withFilter(pickRatingMode(withFilter({ ratingStars: 3 }), 'exact'));
      expect(exact).toMatchObject({ ratingStars: 3, ratingMode: 'exact' });
      const cleared = withFilter(clickRatingStar(exact, 3));
      expect(cleared).toMatchObject({ ratingStars: 0, ratingMode: 'exact' });
      // The mode stays picked, so the next star is "exactly".
      expect(withFilter(clickRatingStar(cleared, 4))).toMatchObject({
        ratingStars: 4,
        ratingMode: 'exact',
      });
    });

    it('picking Unrated drops the stars, and a star after it goes back to and up', () => {
      const picked = withFilter(pickRatingMode(withFilter({ ratingStars: 4 }), 'unrated'));
      expect(picked).toMatchObject({ ratingStars: 0, ratingMode: 'unrated' });
      expect(withFilter(clickRatingStar(picked, 2))).toMatchObject({
        ratingStars: 2,
        ratingMode: 'min',
      });
    });

    it('counts follow the mode', () => {
      const counts = filterCounts(all, withFilter({ ratingMode: 'exact', ratingStars: 3 }));
      expect(counts.tag.all).toBe(1);
      expect(counts.shown).toBe(1);
      expect(filterCounts(all, withFilter({ ratingMode: 'unrated' })).shown).toBe(1);
      expect(filterCounts(all, withFilter({ ratingMode: 'max', ratingStars: 1 })).shown).toBe(2);
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

    it('not red and not yellow shows everything else, unlabelled photos included', () => {
      expect(ids(filterPhotos(all, withFilter({ excludedColors: [1, 3] })))).toEqual([
        blue.id,
        plain.id,
      ]);
    });

    it('takes the excluded classes away from the included ones', () => {
      const filter = withFilter({ colorClasses: [1, 3], excludedColors: [3] });
      expect(ids(filterPhotos(all, filter))).toEqual([red.id]);
      // Excluding every included class leaves nothing, it does not fall back to every colour.
      const none = withFilter({ colorClasses: [1], excludedColors: [1] });
      expect(filterPhotos(all, none)).toEqual([]);
    });

    it('counts the filter with excluded colours the way it lists it', () => {
      const filter = withFilter({ excludedColors: [1] });
      expect(filterCounts(all, filter).shown).toBe(3);
      expect(filterCounts(all, filter).tag.all).toBe(3);
      expect(isFiltering(filter)).toBe(true);
    });

    it('cycles a colour from off to shown to hidden and back to off', () => {
      const off = withFilter({});
      const shown = withFilter(cycleColorClass(off, 2));
      expect(colorFilterState(shown, 2)).toBe('include');
      const hidden = withFilter(cycleColorClass(shown, 2));
      expect(colorFilterState(hidden, 2)).toBe('exclude');
      expect(hidden.colorClasses).toEqual([]);
      const back = withFilter(cycleColorClass(hidden, 2));
      expect(colorFilterState(back, 2)).toBe('off');
      expect(isFiltering(back)).toBe(false);
    });

    it('keeps the other colours as they are when one cycles', () => {
      const filter = withFilter({ colorClasses: [1], excludedColors: [4] });
      expect(cycleColorClass(filter, 2)).toEqual({ colorClasses: [1, 2], excludedColors: [4] });
      expect(cycleColorClass(filter, 1)).toEqual({ colorClasses: [], excludedColors: [4, 1] });
      expect(cycleColorClass(filter, 4)).toEqual({ colorClasses: [1], excludedColors: [] });
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

    it('not exported is everything the export has not finished for, exported is the rest', () => {
      const exported = photo({ status: { export: 'done' } });
      const exporting = photo({ status: { export: 'encoding' } });
      const exportFailed = photo({ status: { export: 'failed' } });
      const untouched = photo();
      const set = [exported, exporting, exportFailed, untouched];
      expect(ids(filterPhotos(set, withFilter({ statuses: ['exported'] })))).toEqual([exported.id]);
      expect(ids(filterPhotos(set, withFilter({ statuses: ['not-exported'] })))).toEqual([
        exporting.id,
        exportFailed.id,
        untouched.id,
      ]);
    });

    it('3 stars and up that are not exported and not sent', () => {
      const keep = photo({ rating: 4 });
      const exportedOne = photo({ rating: 4, status: { export: 'done' } });
      const sentOne = photo({ rating: 4, status: { upload: 'done' } });
      const low = photo({ rating: 2 });
      const filter = withFilter({ ratingStars: 3, statuses: ['not-exported', 'not-sent'] });
      expect(ids(filterPhotos([keep, exportedOne, sentOne, low], filter))).toEqual([keep.id]);
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
      ratingStars: 3,
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
        [wrongRating, { ratingStars: 0 }],
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
        'not-exported': 4,
        exported: 0,
        failed: 1,
        edited: 2,
        'metadata-differs': 0,
      });
      expect(none.shown).toBe(4);

      const rated = filterCounts(all, withFilter({ ratingStars: 3 }));
      expect(rated.tag).toEqual({ all: 2, tagged: 1, untagged: 1 });
      expect(rated.status['not-sent']).toBe(1);
      expect(rated.shown).toBe(2);
    });

    it('counts the export statuses against the rest of the filter', () => {
      const done = photo({ rating: 5, status: { export: 'done' } });
      const waiting = photo({ rating: 5 });
      const lowDone = photo({ rating: 1, status: { export: 'done' } });
      const set = [done, waiting, lowDone];
      const counts = filterCounts(set, withFilter({ ratingStars: 3 }));
      expect(counts.status.exported).toBe(1);
      expect(counts.status['not-exported']).toBe(1);
      // Ticking one makes the other count what it would show on top of it: nothing.
      const exportedOnly = filterCounts(set, withFilter({ statuses: ['exported'] }));
      expect(exportedOnly.status.exported).toBe(2);
      expect(exportedOnly.status['not-exported']).toBe(0);
      expect(exportedOnly.shown).toBe(2);
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
      const filter = withFilter({ tag: 'untagged', statuses: ['not-sent'], ratingStars: 1 });
      expect(filterCounts(all, filter).shown).toBe(filterPhotos(all, filter).length);
    });
  });
});
