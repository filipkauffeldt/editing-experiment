import type { PhotoId } from '@ee/contracts';

/**
 * Where the selection goes when `removed` photos leave `order` (the grid's or the film strip's
 * order): the photo after the last removed one, or the one before the first removed one when
 * they were at the end. Otherwise (a kept photo sits between them, or none was in view) the
 * first remaining photo.
 */
export function nextPhotoAfterRemoval(
  order: readonly PhotoId[],
  removed: ReadonlySet<PhotoId>,
): PhotoId | undefined {
  const positions = order.flatMap((id, index) => (removed.has(id) ? [index] : []));
  if (positions.length === 0) return order.find((id) => !removed.has(id));
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;
  return (
    order.slice(last + 1).find((id) => !removed.has(id)) ??
    order
      .slice(0, first)
      .reverse()
      .find((id) => !removed.has(id)) ??
    // A photo that stayed (its delete failed) between the removed ones.
    order.find((id) => !removed.has(id))
  );
}

/**
 * A copy of a record keyed by photo id (`<id>` or `<id>:<more>`) without the entries of the
 * removed photos. Returns the record itself when nothing was in it.
 */
export function withoutPhotos<T>(
  record: Record<string, T>,
  removed: ReadonlySet<PhotoId>,
): Record<string, T> {
  const keys = Object.keys(record).filter((key) => removed.has(photoIdOfKey(key)));
  if (keys.length === 0) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

/** The photo id at the start of a per-photo key. Photo ids are UUIDs, which have no `:`. */
export function photoIdOfKey(key: string): PhotoId {
  const colon = key.indexOf(':');
  return (colon < 0 ? key : key.slice(0, colon)) as PhotoId;
}
