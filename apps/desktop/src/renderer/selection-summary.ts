import type { IptcFields, Photo } from '@ee/contracts';

/** What a set of photos has in common for one value: the shared value, or that they differ. */
export type Shared<T> = { kind: 'same'; value: T } | { kind: 'differs'; values: T[] };

/** Missing and empty count as the same "nothing", so a blank among filled values differs. */
export function sharedText(values: readonly (string | undefined)[]): Shared<string> {
  const distinct = [...new Set(values.map((value) => value ?? ''))];
  return distinct.length <= 1
    ? { kind: 'same', value: distinct[0] ?? '' }
    : { kind: 'differs', values: distinct };
}

/** Keywords are compared as a set: the order they were written in is not a difference. */
export function sharedKeywords(
  lists: readonly (readonly string[] | undefined)[],
): Shared<string[]> {
  const keyOf = (list: readonly string[] | undefined): string =>
    JSON.stringify([...new Set(list ?? [])].sort());
  const distinct = new Map<string, string[]>();
  for (const list of lists) {
    const key = keyOf(list);
    if (!distinct.has(key)) distinct.set(key, [...new Set(list ?? [])]);
  }
  const all = [...distinct.values()];
  return all.length <= 1 ? { kind: 'same', value: all[0] ?? [] } : { kind: 'differs', values: all };
}

const display = (time: string): string => time.replace('T', ' ');

/**
 * The capture times of a selection as one value: the time itself when they are equal, otherwise
 * `from to until`, with the date given once when it is the same day. Photos without a time are
 * left out; none at all gives an empty string.
 */
export function takenRange(times: readonly (string | undefined)[]): string {
  const known = times.filter((time): time is string => Boolean(time)).sort();
  const first = known[0];
  const last = known.at(-1);
  if (first === undefined || last === undefined || first === last) {
    return first === undefined ? '' : display(first);
  }
  const [firstDate = '', firstTime = ''] = display(first).split(' ');
  const [lastDate = '', lastTime = ''] = display(last).split(' ');
  return firstDate === lastDate
    ? `${firstDate} ${firstTime} to ${lastTime}`
    : `${display(first)} to ${display(last)}`;
}

export interface SelectionSummary {
  size: Shared<string>;
  camera: Shared<string>;
  lens: Shared<string>;
  taken: string;
}

export function summarizeSelection(photos: readonly Photo[]): SelectionSummary {
  return {
    size: sharedText(
      photos.map((photo) =>
        photo.width && photo.height ? `${photo.width} × ${photo.height}` : '',
      ),
    ),
    camera: sharedText(photos.map((photo) => photo.camera?.model)),
    lens: sharedText(photos.map((photo) => photo.camera?.lens)),
    taken: takenRange(photos.map((photo) => photo.captureTime)),
  };
}

/** Caption and keywords of the photos whose fields are loaded; `undefined` while any is missing. */
export function sharedFields(
  ids: readonly string[],
  fields: Readonly<Record<string, IptcFields | undefined>>,
): { caption: Shared<string>; keywords: Shared<string[]> } | undefined {
  const loaded: IptcFields[] = [];
  for (const id of ids) {
    const entry = fields[id];
    if (!entry) return undefined;
    loaded.push(entry);
  }
  return {
    caption: sharedText(loaded.map((entry) => entry.caption)),
    keywords: sharedKeywords(loaded.map((entry) => entry.keywords)),
  };
}
