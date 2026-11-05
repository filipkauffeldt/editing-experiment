import { asSourceId, type CardSource, type DetectedCard, type SourceConfig } from '@ee/contracts';

/** A card source the app created from a discovered card (not one added by hand in Settings). */
export const isDiscoveredCardSource = (source: SourceConfig): source is CardSource =>
  source.kind === 'card' && source.discovered === true;

/**
 * Links each mounted card to the persisted source that already stands for its volume, so
 * the filter choices and the incremental state of a card survive taking it out and putting
 * it back.
 *
 * A volume has no identity beyond what the OS shows without native modules, so the match is:
 * 1. the same mount path (a card that stayed, or came back to the same place), then
 * 2. the same volume label, for a source whose mount path is not a mounted card now (the card
 *    came back as `F:\` instead of `E:\`, or as `NIKON Z 61`).
 * Every source is used for at most one card, so two cards that share a label each keep
 * their own source. If the two swap mount paths while both are out, they swap sources as well;
 * the files are the same cards' files either way, only the filters would trade places.
 */
export function matchCardSources(
  cards: readonly DetectedCard[],
  sources: readonly SourceConfig[],
): Map<string, CardSource> {
  const discovered = sources.filter(isDiscoveredCardSource);
  const matches = new Map<string, CardSource>();
  const used = new Set<string>();
  const mounted = new Set(cards.map((card) => card.mountPath));

  for (const card of cards) {
    const same = discovered.find(
      (source) => source.mountPath === card.mountPath && !used.has(source.id),
    );
    if (same) {
      matches.set(card.mountPath, same);
      used.add(same.id);
    }
  }
  for (const card of cards) {
    if (matches.has(card.mountPath) || card.volumeLabel === undefined) continue;
    const byLabel = discovered.find(
      (source) =>
        !used.has(source.id) &&
        !mounted.has(source.mountPath) &&
        source.volumeLabel === card.volumeLabel,
    );
    if (byLabel) {
      matches.set(card.mountPath, byLabel);
      used.add(byLabel.id);
    }
  }
  return matches;
}

/**
 * Cards that a source added by hand in Settings already covers are not offered again:
 * that source is ingested with the others and would otherwise copy the card twice.
 */
export function unconfiguredCards(
  cards: readonly DetectedCard[],
  sources: readonly SourceConfig[],
): DetectedCard[] {
  const manual = new Set(
    sources.filter((source) => source.kind === 'card' && !source.discovered).map(mountOf),
  );
  return cards.filter((card) => !manual.has(card.mountPath));
}

const mountOf = (source: SourceConfig): string => (source.kind === 'card' ? source.mountPath : '');

/** The source to save when `card` is picked: the matched one with its mount point brought up to date, or a new one. */
export function cardSourceFor(
  card: DetectedCard,
  match: CardSource | undefined,
  sources: readonly SourceConfig[],
): CardSource {
  if (match) {
    return {
      ...match,
      mountPath: card.mountPath,
      ...(card.volumeLabel === undefined ? {} : { volumeLabel: card.volumeLabel }),
    };
  }
  return {
    kind: 'card',
    id: asSourceId(`card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
    name: uniqueName(card.volumeLabel ?? card.mountPath, sources),
    mountPath: card.mountPath,
    ...(card.volumeLabel === undefined ? {} : { volumeLabel: card.volumeLabel }),
    discovered: true,
  };
}

/**
 * Two cards can both be called `NIKON Z 6`. The source name feeds `{sourceName}` in the
 * subfolder template, so the second one becomes `NIKON Z 6 (2)` rather than landing in the same folder.
 */
function uniqueName(label: string, sources: readonly SourceConfig[]): string {
  const taken = new Set(sources.map((source) => source.name));
  if (!taken.has(label)) return label;
  for (let n = 2; ; n += 1) {
    const candidate = `${label} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Sources `ingest:start` should run: discovered cards only when picked, and every folder or
 * server unless it was unticked.
 */
export function sourcesToIngest(
  sources: readonly SourceConfig[],
  picked: readonly string[],
  unpicked: readonly string[] = [],
): SourceConfig[] {
  const pickedSet = new Set(picked);
  const unpickedSet = new Set(unpicked);
  return sources.filter((source) =>
    isDiscoveredCardSource(source) ? pickedSet.has(source.id) : !unpickedSet.has(source.id),
  );
}
