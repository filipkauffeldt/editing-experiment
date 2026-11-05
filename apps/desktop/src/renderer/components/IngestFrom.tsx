import type { CardSource, DetectedCard, SourceConfig } from '@ee/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { isDiscoveredCardSource, matchCardSources, unconfiguredCards } from '../cards';
import { filterSummary, photoCount } from '../ingest-summary';
import type { IngestRun } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { PlusIcon, RefreshIcon } from './icons';
import { SourceFilters, sourceFilterValues } from './SourceFilters';
import { Button } from './ui/Button';
import { Dot } from './ui/Dot';
import styles from './IngestFrom.module.css';

export function progressText(source: SourceConfig, run: IngestRun | undefined): string {
  if (!run) return 'not started';
  const selected = run.filesTotal + (run.filesSkipped ?? 0);
  const parts = [
    run.state === 'finished' ? 'done' : `${run.state} ${run.filesDone}/${run.filesTotal}`,
  ];
  if (run.filesSkipped) {
    parts.push(`${run.filesTotal} new · ${run.filesSkipped} already ingested`);
  }
  if (run.filesScanned !== undefined && selected !== run.filesScanned) {
    const what =
      source.kind !== 'ftp' && source.kind !== 'sftp' && source.lockFilter === 'locked'
        ? 'locked'
        : source.kind !== 'ftp' && source.kind !== 'sftp' && source.lockFilter === 'unlocked'
          ? 'unlocked'
          : 'selected';
    parts.push(`${selected} ${what} of ${run.filesScanned}`);
  }
  return parts.join(' · ');
}

const runTone = (run: IngestRun | undefined): 'error' | 'ok' | 'idle' =>
  run?.state === 'failed'
    ? 'error'
    : run?.state === 'running' || run?.state === 'watching'
      ? 'ok'
      : 'idle';

/** Stops one source; disabled while its run is winding down after the click. */
function StopIngestButton({ source }: { source: SourceConfig }) {
  const store = useAppStore();
  const stopping = useAppState().ingestStopping[source.id] === true;
  return (
    <Button
      size="small"
      aria-label={`Stop ${source.name}`}
      title={stopping ? `Stopping ${source.name}…` : `Stop ${source.name}`}
      disabled={stopping}
      onClick={() => void store.stopIngest(source.id)}
    >
      {stopping ? 'Stopping…' : 'Stop'}
    </Button>
  );
}

/** Progress line, bar, error and warning of one source's run. */
function RunStatus({ source, run }: { source: SourceConfig; run: IngestRun }) {
  const percent = run.filesTotal > 0 ? Math.min(100, (run.filesDone / run.filesTotal) * 100) : 0;
  const stoppable = run.state === 'running' || run.state === 'watching';
  return (
    <div className={`${styles.run} ${run.state === 'failed' ? styles.failed : ''}`}>
      <span className={styles.state}>
        <Dot tone={runTone(run)} />
        <span className="mono">{progressText(source, run)}</span>
        {stoppable && <StopIngestButton source={source} />}
      </span>
      <span className={styles.bar}>
        <span style={{ width: `${percent}%` }} />
      </span>
      {run.error && <span className={styles.error}>{run.error}</span>}
      {run.warning && <span className={styles.warning}>{run.warning}</span>}
    </div>
  );
}

const countText = (card: DetectedCard, counting: boolean): string =>
  card.imageCount === undefined ? (counting ? 'counting…' : '—') : photoCount(card.imageCount);

/** Long enough to read as "it looked", for a scan that answers in a few milliseconds. */
const MIN_BUSY_MS = 400;

/** Scans again on click; the arrow turns while the scan runs. */
function RescanButton() {
  const store = useAppStore();
  const scanning = useAppState().cardsScanning;
  const [held, setHeld] = useState(false);
  const busy = scanning || held;
  return (
    <Button
      variant="ghost"
      size="small"
      aria-label="Rescan cards"
      title="Rescan cards"
      aria-busy={busy}
      data-testid="rescan-cards"
      onClick={() => {
        setHeld(true);
        void store.refreshCards().finally(() => setTimeout(() => setHeld(false), MIN_BUSY_MS));
      }}
    >
      <RefreshIcon className={busy ? styles.spinning : undefined} />
    </Button>
  );
}

/**
 * Saves each click immediately. The local copy keeps fast clicks from racing:
 * the next change starts from what the user just chose, not an older saved row.
 */
function IngestSourceFilters({
  source,
}: {
  source: Extract<SourceConfig, { kind: 'folder' | 'card' }>;
}) {
  const store = useAppStore();
  const [value, setValue] = useState(() => sourceFilterValues(source));
  useEffect(() => {
    // A save from another view (e.g. settings) is the new truth.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(sourceFilterValues(source));
  }, [source]);

  return (
    <SourceFilters
      value={value}
      name={source.name}
      onChange={(next) => {
        setValue(next);
        void store
          .saveSource({ ...source, ...next })
          .catch((cause: unknown) =>
            store.notify(
              'error',
              `Could not save the source filters: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            ),
          );
      }}
    />
  );
}

interface RowProps {
  testId: string;
  name: string;
  /** Absent for a card that is gone: there is nothing to tick. */
  checked?: boolean;
  onToggle?(checked: boolean): void;
  /** Count or kind, right-aligned. */
  right: ReactNode;
  /** The one detail line; a button when the source has filters to open. */
  detail: ReactNode;
  run?: IngestRun | undefined;
  /** Needed with `run`, which is only there for a source that was saved. */
  source?: SourceConfig;
  children?: ReactNode;
}

function Row({ testId, name, checked, onToggle, right, detail, run, source, children }: RowProps) {
  return (
    <li className={styles.row} data-testid={testId}>
      <div className={styles.head}>
        {onToggle ? (
          <label className={styles.pick}>
            <input
              type="checkbox"
              checked={checked === true}
              onChange={(event) => onToggle(event.target.checked)}
            />
            <span className={styles.name}>{name}</span>
          </label>
        ) : (
          <span className={styles.name}>{name}</span>
        )}
        <span className={`${styles.right} mono`}>{right}</span>
      </div>
      {detail}
      {run && source && <RunStatus source={source} run={run} />}
      {children}
    </li>
  );
}

/** The detail line of a local source: where it is and its filters, which open on click. */
function FilterLine({
  source,
  location,
  open,
  onToggle,
}: {
  source: Extract<SourceConfig, { kind: 'folder' | 'card' }>;
  location: string;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className={styles.detail}
      aria-expanded={open}
      aria-label={`Filters for ${source.name}`}
      title={`${location}\nChange what is copied from ${source.name}`}
      onClick={onToggle}
    >
      <span className="mono">{location}</span>
      <span className={styles.summary}>{filterSummary(sourceFilterValues(source))}</span>
    </button>
  );
}

/**
 * Where the photos come from: the cards in the machine, found on their own, and the folders and
 * servers from Settings, in one list. Cards are scanned when the view opens and by Rescan; a card
 * that is gone after a scan disappears, unless its run is still going or failed, in which case the
 * row stays with the run's own error until dismissed.
 */
export function IngestFrom({ className }: { className?: string }) {
  const store = useAppStore();
  const state = useAppState();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Cards are looked for when the view opens and when the user asks; nothing polls.
  useEffect(() => {
    void store.refreshCards();
  }, [store]);

  const toggleOpen = (id: string): void => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  };

  const offered = unconfiguredCards(state.cards, state.sources);
  const matches = matchCardSources(state.cards, state.sources);
  const shown = new Set([...matches.values()].map((source) => source.id));
  const gone = state.sources.filter(
    (source): source is CardSource =>
      isDiscoveredCardSource(source) &&
      !shown.has(source.id) &&
      (state.ingest[source.id]?.state === 'running' || state.ingest[source.id]?.state === 'failed'),
  );
  // Discovered cards have their rows above; hand-added sources and servers are listed after them.
  const listed = state.sources.filter(
    (source): source is SourceConfig => !isDiscoveredCardSource(source),
  );

  return (
    <section className={`${styles.from} ${className ?? ''}`} data-testid="ingest-sources">
      <header className={styles.header}>
        <h3 className={styles.title}>From</h3>
        <RescanButton />
        <Button
          variant="ghost"
          size="small"
          title="Add a folder, card or server in Settings → Sources"
          onClick={() => store.openDialog('sources')}
        >
          <PlusIcon size={9} /> Folder or server
        </Button>
      </header>
      <ul className={styles.list} data-testid="ingest-source-list">
        {offered.map((card) => {
          const source = matches.get(card.mountPath);
          const label = card.volumeLabel ?? card.mountPath;
          const picked = source !== undefined && state.pickedCards.includes(source.id);
          return (
            <Row
              key={card.mountPath}
              testId="ingest-card"
              name={label}
              checked={picked}
              source={source}
              run={source ? state.ingest[source.id] : undefined}
              right={countText(card, state.cardsCounting)}
              onToggle={(checked) => {
                void store
                  .pickCard(card, checked)
                  .catch((cause: unknown) =>
                    store.notify(
                      'error',
                      `Could not pick ${label}: ${
                        cause instanceof Error ? cause.message : String(cause)
                      }`,
                    ),
                  );
              }}
              detail={
                source ? (
                  <FilterLine
                    source={source}
                    location={card.mountPath}
                    open={open.has(source.id)}
                    onToggle={() => toggleOpen(source.id)}
                  />
                ) : (
                  <span className={`${styles.detailText} mono`} title={card.mountPath}>
                    {card.mountPath}
                  </span>
                )
              }
            >
              {source && open.has(source.id) && (
                <div className={styles.filters}>
                  <IngestSourceFilters source={source} />
                </div>
              )}
            </Row>
          );
        })}
        {gone.map((source) => {
          const run = state.ingest[source.id];
          return (
            <Row
              key={source.id}
              testId="ingest-card-removed"
              name={source.name}
              source={source}
              run={run}
              right="removed"
              detail={
                <span className={`${styles.detailText} mono`} title={source.mountPath}>
                  {source.mountPath}
                </span>
              }
            >
              {run?.state === 'failed' && (
                <div className={styles.filters}>
                  <Button onClick={() => store.dismissIngestFailure(run.jobId)}>Dismiss</Button>
                </div>
              )}
            </Row>
          );
        })}
        {listed.map((source) => {
          const local = source.kind === 'folder' || source.kind === 'card';
          const location =
            source.kind === 'folder'
              ? source.path
              : source.kind === 'card'
                ? source.mountPath
                : `${source.host} · ${source.remotePath}`;
          return (
            <Row
              key={source.id}
              testId="ingest-source"
              name={source.name}
              checked={!state.unpickedSources.includes(source.id)}
              onToggle={(checked) => store.pickSource(source.id, checked)}
              source={source}
              run={state.ingest[source.id]}
              right={source.kind}
              detail={
                local ? (
                  <FilterLine
                    source={source}
                    location={location}
                    open={open.has(source.id)}
                    onToggle={() => toggleOpen(source.id)}
                  />
                ) : (
                  <span className={`${styles.detailText} mono`} title={location}>
                    {location}
                  </span>
                )
              }
            >
              {local && open.has(source.id) && (
                <div className={styles.filters}>
                  <IngestSourceFilters source={source} />
                </div>
              )}
            </Row>
          );
        })}
        {offered.length === 0 && gone.length === 0 && (
          <li className={styles.empty}>No card found. Insert one and press Rescan.</li>
        )}
      </ul>
    </section>
  );
}
