import type {
  Photo,
  PhotoId,
  PhotoRatingFilter,
  PhotoRatingMode,
  PhotoStatusFilter,
  SourceId,
  StoredFilter,
} from '@ee/contracts';

/**
 * The one filter both the Library and Develop apply. Pure: a photo, a filter and (when a text
 * search is on) the ids the search found. Everything here is AND between filters; inside the
 * colour filter the included classes are OR (a photo has one colour) and the excluded ones are
 * taken away from them.
 */
export type TagFilter = 'all' | 'tagged' | 'untagged';

export const TAG_FILTERS: readonly { id: TagFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tagged', label: 'Tagged' },
  { id: 'untagged', label: 'Untagged' },
];

export type StatusFilter = PhotoStatusFilter;

export const STATUS_FILTERS: readonly { id: StatusFilter; label: string }[] = [
  { id: 'not-sent', label: 'Not sent' },
  { id: 'not-exported', label: 'Not exported' },
  { id: 'exported', label: 'Exported' },
  { id: 'failed', label: 'Failed' },
  { id: 'edited', label: 'Edited' },
  { id: 'metadata-differs', label: 'Differs from template' },
];

/** What the rating selector offers: the three comparisons, and the unrated photos on their own. */
export type RatingMode = PhotoRatingMode | 'unrated';

export const RATING_MODES: readonly { id: RatingMode; label: string }[] = [
  { id: 'min', label: 'And up' },
  { id: 'exact', label: 'Exactly' },
  { id: 'max', label: 'At most' },
  { id: 'unrated', label: 'Unrated' },
];

export interface FilterState {
  tag: TagFilter;
  /** 0 = no stars picked, 1..5 = the star clicked. What it means depends on `ratingMode`. */
  ratingStars: number;
  /**
   * `min` (and up, the default), `exact`, `max` (and fewer, unrated included) compare with
   * `ratingStars`; `unrated` shows photos with no rating and ignores the stars.
   */
  ratingMode: RatingMode;
  /** Colour classes 1..8 to show; empty = every colour. */
  colorClasses: readonly number[];
  /** Colour classes 1..8 to hide. A class is never both shown and hidden. */
  excludedColors: readonly number[];
  /** A photo has to match every ticked status. */
  statuses: readonly StatusFilter[];
  /** `cameraKey` of a body. */
  camera?: string;
  sourceId?: SourceId;
  /** The text searched for, as typed (trimmed when applied). */
  search: string;
}

export const initialFilter = (): FilterState => ({
  tag: 'all',
  ratingStars: 0,
  ratingMode: 'min',
  colorClasses: [],
  excludedColors: [],
  statuses: [],
  search: '',
});

export const hasSearch = (filter: FilterState): boolean => filter.search.trim() !== '';

/** The filter as the settings keep it (what saved filters and the remembered filter hold). */
export const toStoredFilter = (filter: FilterState): StoredFilter => ({
  tag: filter.tag,
  ratingStars: filter.ratingStars,
  ratingMode: filter.ratingMode,
  colorClasses: [...filter.colorClasses],
  excludedColors: [...filter.excludedColors],
  statuses: [...filter.statuses],
  ...(filter.camera === undefined ? {} : { camera: filter.camera }),
  ...(filter.sourceId === undefined ? {} : { sourceId: filter.sourceId }),
  search: filter.search,
});

export const fromStoredFilter = (stored: StoredFilter): FilterState => ({
  tag: stored.tag,
  ratingStars: stored.ratingStars,
  ratingMode: stored.ratingMode,
  colorClasses: [...stored.colorClasses],
  excludedColors: [...stored.excludedColors],
  statuses: [...stored.statuses],
  ...(stored.camera === undefined ? {} : { camera: stored.camera }),
  ...(stored.sourceId === undefined ? {} : { sourceId: stored.sourceId }),
  search: stored.search,
});

/** Whether any filter narrows the photos (what the clear button and the empty state react to). */
export function isFiltering(filter: FilterState): boolean {
  return (
    filter.tag !== 'all' ||
    ratingFilter(filter) !== undefined ||
    filter.colorClasses.length > 0 ||
    filter.excludedColors.length > 0 ||
    filter.statuses.length > 0 ||
    filter.camera !== undefined ||
    filter.sourceId !== undefined ||
    hasSearch(filter)
  );
}

/** The rating filter in the form the index takes, or nothing when it is off. */
export function ratingFilter(
  filter: Pick<FilterState, 'ratingStars' | 'ratingMode'>,
): PhotoRatingFilter | undefined {
  if (filter.ratingMode === 'unrated') return { mode: 'exact', stars: 0 };
  return filter.ratingStars > 0
    ? { mode: filter.ratingMode, stars: filter.ratingStars }
    : undefined;
}

export function matchesRating(rating: number, wanted: PhotoRatingFilter | undefined): boolean {
  if (wanted === undefined) return true;
  switch (wanted.mode) {
    case 'min':
      return rating >= wanted.stars;
    case 'exact':
      return rating === wanted.stars;
    case 'max':
      return rating <= wanted.stars;
  }
}

export function cameraKey(photo: Photo): string {
  const camera = photo.camera;
  if (!camera) return '';
  return [camera.model ?? camera.make ?? 'Unknown', camera.serialNumber ?? ''].join('|');
}

export function cameraLabel(key: string): string {
  const [model, serial] = key.split('|');
  return serial ? `${model} · ${serial}` : (model ?? key);
}

export function cameraOptions(photos: readonly Photo[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const photo of photos) {
    const key = cameraKey(photo);
    if (key && !seen.has(key)) seen.set(key, cameraLabel(key));
  }
  return [...seen]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Retouched photos count as edited, as the Library's old Edited collection did. */
export const isEdited = (photo: Photo): boolean =>
  photo.status.edited || photo.versions.some((version) => version.kind === 'retouch');

export function matchesStatus(photo: Photo, status: StatusFilter): boolean {
  switch (status) {
    case 'not-sent':
      return photo.status.upload !== 'done';
    case 'not-exported':
      return photo.status.export !== 'done';
    case 'exported':
      return photo.status.export === 'done';
    case 'failed':
      return photo.status.upload === 'failed';
    case 'edited':
      return isEdited(photo);
    case 'metadata-differs':
      return photo.status.metadataDiffersFromTemplate;
  }
}

const matchesTag = (photo: Photo, tag: TagFilter): boolean =>
  tag === 'all' || (tag === 'tagged') === photo.tagged;

/**
 * Everything except the tag and status filters, which the counts leave out one at a time.
 * `searchIds` undefined means no search result is known (none on, or not here yet): no restriction.
 */
function matchesRest(
  photo: Photo,
  filter: FilterState,
  searchIds: ReadonlySet<PhotoId> | undefined,
): boolean {
  if (!matchesRating(photo.rating, ratingFilter(filter))) return false;
  if (filter.colorClasses.length > 0 && !filter.colorClasses.includes(photo.colorClass))
    return false;
  if (filter.excludedColors.includes(photo.colorClass)) return false;
  if (filter.camera !== undefined && cameraKey(photo) !== filter.camera) return false;
  if (filter.sourceId !== undefined && photo.sourceId !== filter.sourceId) return false;
  if (hasSearch(filter) && searchIds !== undefined && !searchIds.has(photo.id)) return false;
  return true;
}

export function matchesFilter(
  photo: Photo,
  filter: FilterState,
  searchIds?: ReadonlySet<PhotoId>,
): boolean {
  return (
    matchesTag(photo, filter.tag) &&
    filter.statuses.every((status) => matchesStatus(photo, status)) &&
    matchesRest(photo, filter, searchIds)
  );
}

export function filterPhotos(
  photos: readonly Photo[],
  filter: FilterState,
  searchIds?: ReadonlySet<PhotoId>,
): Photo[] {
  return photos.filter((photo) => matchesFilter(photo, filter, searchIds));
}

export interface FilterCounts {
  /** What each tag option would show, with every other filter as it is. */
  tag: Record<TagFilter, number>;
  /** What each status would show if it were ticked, with every other filter as it is. */
  status: Record<StatusFilter, number>;
  /** What the filter shows now. */
  shown: number;
}

/**
 * The numbers beside the options: for each one, how many photos the list would hold if that
 * option were the one picked (or ticked) and the rest of the filter stayed. So a number never
 * promises more than the click delivers.
 */
export function filterCounts(
  photos: readonly Photo[],
  filter: FilterState,
  searchIds?: ReadonlySet<PhotoId>,
): FilterCounts {
  const counts: FilterCounts = {
    tag: { all: 0, tagged: 0, untagged: 0 },
    status: Object.fromEntries(STATUS_FILTERS.map(({ id }) => [id, 0])) as Record<
      StatusFilter,
      number
    >,
    shown: 0,
  };
  for (const photo of photos) {
    if (!matchesRest(photo, filter, searchIds)) continue;
    const failing = filter.statuses.filter((status) => !matchesStatus(photo, status));
    const tagOk = matchesTag(photo, filter.tag);
    if (failing.length === 0) {
      counts.tag.all += 1;
      if (photo.tagged) counts.tag.tagged += 1;
      else counts.tag.untagged += 1;
      if (tagOk) counts.shown += 1;
    }
    if (!tagOk) continue;
    for (const { id } of STATUS_FILTERS) {
      // A ticked status counts the photos that pass; an unticked one the photos it would keep.
      const others = failing.filter((status) => status !== id);
      if (others.length === 0 && matchesStatus(photo, id)) counts.status[id] += 1;
    }
  }
  return counts;
}

/** Click star `n`: it becomes the filter, and the star that is already the filter clears it. */
export function clickRatingStar(
  filter: Pick<FilterState, 'ratingStars' | 'ratingMode'>,
  n: number,
): Pick<FilterState, 'ratingStars' | 'ratingMode'> {
  // A star means nothing next to Unrated, so it goes back to the default comparison.
  if (filter.ratingMode === 'unrated') return { ratingStars: n, ratingMode: 'min' };
  return { ratingStars: filter.ratingStars === n ? 0 : n, ratingMode: filter.ratingMode };
}

/** Pick a comparison. The stars stay, so "3 and up" becomes "exactly 3"; Unrated drops them. */
export function pickRatingMode(
  filter: Pick<FilterState, 'ratingStars'>,
  mode: RatingMode,
): Pick<FilterState, 'ratingStars' | 'ratingMode'> {
  return { ratingStars: mode === 'unrated' ? 0 : filter.ratingStars, ratingMode: mode };
}

export type ColorFilterState = 'off' | 'include' | 'exclude';

export function colorFilterState(filter: FilterState, colorClass: number): ColorFilterState {
  if (filter.colorClasses.includes(colorClass)) return 'include';
  if (filter.excludedColors.includes(colorClass)) return 'exclude';
  return 'off';
}

/** A click on a colour: off, then shown, then hidden, then off again. */
export function cycleColorClass(
  filter: Pick<FilterState, 'colorClasses' | 'excludedColors'>,
  colorClass: number,
): Pick<FilterState, 'colorClasses' | 'excludedColors'> {
  const included = filter.colorClasses.includes(colorClass);
  const excluded = filter.excludedColors.includes(colorClass);
  const without = (list: readonly number[]): number[] =>
    list.filter((candidate) => candidate !== colorClass);
  if (included) {
    return {
      colorClasses: without(filter.colorClasses),
      excludedColors: [...filter.excludedColors, colorClass],
    };
  }
  if (excluded) {
    return {
      colorClasses: [...filter.colorClasses],
      excludedColors: without(filter.excludedColors),
    };
  }
  return {
    colorClasses: [...filter.colorClasses, colorClass],
    excludedColors: [...filter.excludedColors],
  };
}

export const toggleInList = <T>(list: readonly T[], item: T): T[] =>
  list.includes(item) ? list.filter((candidate) => candidate !== item) : [...list, item];
