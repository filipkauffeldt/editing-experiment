import type { DetectedCard, FileTypeFilter, LockFilter, SourceConfig } from '@ee/contracts';
import { isDiscoveredCardSource, matchCardSources } from './cards';

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

export const photoCount = (count: number): string => plural(count, 'photo');

/** The image count a source reports before it is ingested; only a mounted card knows one. */
export function reportedCount(
  source: SourceConfig,
  cards: readonly DetectedCard[],
  sources: readonly SourceConfig[],
): number | undefined {
  if (!isDiscoveredCardSource(source)) return undefined;
  for (const [mountPath, match] of matchCardSources(cards, sources)) {
    if (match.id === source.id)
      return cards.find((card) => card.mountPath === mountPath)?.imageCount;
  }
  return undefined;
}

/** Sum of the ticked sources' counts, or `undefined` while any of them is not known. */
export function totalCount(counts: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  for (const count of counts) {
    if (count === undefined) return undefined;
    total += count;
  }
  return total;
}

/** `Ingest`, or `Ingest 483 photos` once every ticked source has reported its count. */
export const ingestLabel = (count: number | undefined): string =>
  count === undefined ? 'Ingest' : `Ingest ${photoCount(count)}`;

/** `2 cards · 1 server`: what the ticked sources are. */
export function sourceKinds(sources: readonly SourceConfig[]): string {
  const cards = sources.filter((source) => source.kind === 'card').length;
  const folders = sources.filter((source) => source.kind === 'folder').length;
  const servers = sources.length - cards - folders;
  return [
    cards > 0 ? plural(cards, 'card') : '',
    folders > 0 ? plural(folders, 'folder') : '',
    servers > 0 ? plural(servers, 'server') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const TYPES: Record<FileTypeFilter, string | undefined> = {
  raw: 'RAW only',
  jpeg: 'JPEG only',
  both: undefined,
};
const LOCKS: Record<LockFilter, string | undefined> = {
  locked: 'locked only',
  unlocked: 'unlocked only',
  all: undefined,
};

/** The filters that are not the default, as one line; `all files` when none is set. */
export function filterSummary(filters: {
  fileTypes: FileTypeFilter;
  lockFilter: LockFilter;
  incremental: boolean;
}): string {
  return (
    [
      TYPES[filters.fileTypes],
      LOCKS[filters.lockFilter],
      filters.incremental ? undefined : 'including already ingested',
    ]
      .filter(Boolean)
      .join(' · ') || 'all files'
  );
}
