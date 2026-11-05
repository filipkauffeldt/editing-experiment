import type { Photo, PhotoId, SourceId } from '@ee/contracts';

/**
 * The one filter both the Library and Develop apply. Pure: a photo, a filter and (when a text
 * search is on) the ids the search found. Everything here is AND between filters; inside the
 * colour filter the classes are OR (a photo has one colour).
 */
export type TagFilter = 'all' | 'tagged' | 'untagged';

export const TAG_FILTERS: readonly { id: TagFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tagged', label: 'Tagged' },
  { id: 'untagged', label: 'Untagged' },
];

export type StatusFilter = 'not-sent' | 'failed' | 'edited' | 'metadata-differs';

export const STATUS_FILTERS: readonly { id: StatusFilter; label: string }[] = [
  { id: 'not-sent', label: 'Not sent' },
  { id: 'failed', label: 'Failed' },
  { id: 'edited', label: 'Edited' },
  { id: 'metadata-differs', label: 'Metadata differs' },
];

export interface FilterState {
  tag: TagFilter;
  /** 0 = off, 1..5 = this many stars and up; unrated photos are out while it is on. */
  minRating: number;
  /** Colour classes 1..8 to show; empty = every colour. */
  colorClasses: readonly number[];
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
  minRating: 0,
  colorClasses: [],
  statuses: [],
  search: '',
});

export const hasSearch = (filter: FilterState): boolean => filter.search.trim() !== '';

/** Whether any filter narrows the photos (what the clear button and the empty state react to). */
export function isFiltering(filter: FilterState): boolean {
  return (
    filter.tag !== 'all' ||
    filter.minRating > 0 ||
    filter.colorClasses.length > 0 ||
    filter.statuses.length > 0 ||
    filter.camera !== undefined ||
    filter.sourceId !== undefined ||
    hasSearch(filter)
  );
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
  if (filter.minRating > 0 && photo.rating < filter.minRating) return false;
  if (filter.colorClasses.length > 0 && !filter.colorClasses.includes(photo.colorClass))
    return false;
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
    status: { 'not-sent': 0, failed: 0, edited: 0, 'metadata-differs': 0 },
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

/** Click star `n`: "n and up"; the star that is already the filter clears it. */
export const toggleMinRating = (current: number, n: number): number => (current === n ? 0 : n);

export const toggleInList = <T>(list: readonly T[], item: T): T[] =>
  list.includes(item) ? list.filter((candidate) => candidate !== item) : [...list, item];
