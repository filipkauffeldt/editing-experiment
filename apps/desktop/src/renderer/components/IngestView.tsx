import type { CardSource, DetectedCard, SourceConfig } from '@ee/contracts';
import { useEffect, useState } from 'react';
import { isDiscoveredCardSource, matchCardSources, unconfiguredCards } from '../cards';
import { useAppState, useAppStore } from '../store-context';
import type { IngestRun } from '../store';
import { ActionBar, barStyles } from './ActionBar';
import { Dot } from './ui/Dot';
import { Button } from './ui/Button';
import { IngestSection } from './SettingsDialog';
import { SourceFilters, sourceFilterValues } from './SourceFilters';
import styles from './IngestView.module.css';

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

function progressText(source: SourceConfig, run: IngestRun | undefined): string {
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

/** Progress line, bar, error and warning of one source's run. */
function RunStatus({ source, run }: { source: SourceConfig; run: IngestRun | undefined }) {
  const percent =
    run && run.filesTotal > 0 ? Math.min(100, (run.filesDone / run.filesTotal) * 100) : 0;
  return (
    <>
      <span className={`${styles.state} mono`}>{progressText(source, run)}</span>
      <span className={styles.bar}>
        <span style={{ width: `${percent}%` }} />
      </span>
      {run?.error && <span className={styles.error}>{run.error}</span>}
      {run?.warning && <span className={styles.warning}>{run.warning}</span>}
    </>
  );
}

const countText = (card: DetectedCard): string =>
  card.imageCount === undefined
    ? 'counting…'
    : `${card.imageCount} ${card.imageCount === 1 ? 'image' : 'images'}`;

/**
 * The cards in the machine right now, found on their own: tick the ones to ingest. Polls
 * while the view is open. A card that is pulled out disappears, unless its run is still going
 * or failed, in which case the row stays with the run's own error until dismissed.
 */
function CardsSection() {
  const store = useAppStore();
  const state = useAppState();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => store.watchCards(), [store]);

  const offered = unconfiguredCards(state.cards, state.sources);
  const matches = matchCardSources(state.cards, state.sources);
  const shown = new Set([...matches.values()].map((source) => source.id));
  const gone = state.sources.filter(
    (source): source is CardSource =>
      isDiscoveredCardSource(source) &&
      !shown.has(source.id) &&
      (state.ingest[source.id]?.state === 'running' ||
        (state.ingest[source.id]?.state === 'failed' &&
          !dismissed.has(state.ingest[source.id]?.jobId ?? ''))),
  );

  return (
    <>
      <h3 className={styles.title}>Cards</h3>
      <ul className={styles.list} data-testid="ingest-cards">
        {offered.length === 0 && gone.length === 0 && (
          <li className={styles.empty}>No card found. Insert one and it shows up here.</li>
        )}
        {offered.map((card) => {
          const source = matches.get(card.mountPath);
          const picked = source !== undefined && state.pickedCards.includes(source.id);
          const run = source ? state.ingest[source.id] : undefined;
          const label = card.volumeLabel ?? card.mountPath;
          return (
            <li key={card.mountPath} className={styles.source} data-testid="ingest-card">
              <Dot tone={runTone(run)} />
              <label className={styles.cardPick}>
                <input
                  type="checkbox"
                  checked={picked}
                  onChange={(event) => {
                    void store
                      .pickCard(card, event.target.checked)
                      .catch((cause: unknown) =>
                        store.notify(
                          'error',
                          `Could not pick ${label}: ${
                            cause instanceof Error ? cause.message : String(cause)
                          }`,
                        ),
                      );
                  }}
                />
                <span className={styles.name}>{label}</span>
              </label>
              <span className={`${styles.kind} mono`}>{countText(card)}</span>
              <span className={`${styles.mount} mono`} title={card.mountPath}>
                {card.mountPath}
              </span>
              {picked && source && (
                <>
                  <RunStatus source={source} run={run} />
                  <div className={styles.sourceFilters}>
                    <IngestSourceFilters source={source} />
                  </div>
                </>
              )}
            </li>
          );
        })}
        {gone.map((source) => {
          const run = state.ingest[source.id];
          return (
            <li key={source.id} className={styles.source} data-testid="ingest-card-removed">
              <Dot tone={runTone(run)} />
              <span className={styles.name}>{source.name}</span>
              <span className={styles.kind}>removed</span>
              <span className={`${styles.mount} mono`} title={source.mountPath}>
                {source.mountPath}
              </span>
              <RunStatus source={source} run={run} />
              {run?.state === 'failed' && (
                <div className={styles.sourceFilters}>
                  <Button onClick={() => setDismissed(new Set([...dismissed, run.jobId]))}>
                    Dismiss
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
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

/** Ingest: every source with its progress, and the ingest settings (destination, rename, template). */
export function IngestView() {
  const store = useAppStore();
  const state = useAppState();
  const ingest = state.settings?.ingest;
  const templatePath = ingest?.metadataTemplatePath;
  const templateMode = ingest?.metadataTemplateMode ?? 'replace';
  const presetId = ingest?.developPresetId;
  const presetName = presetId
    ? (state.presets.find((preset) => preset.id === presetId)?.name ?? presetId)
    : 'None';
  // Discovered cards have their own section; hand-added sources and servers are listed as before.
  const listedSources = state.sources.filter(
    (source) => !(source.kind === 'card' && source.discovered),
  );
  return (
    <div className={styles.view} data-testid="ingest-view">
      <section className={styles.sources}>
        <CardsSection />
        <h3 className={styles.title}>Sources</h3>
        <p className={styles.activeChoices} data-testid="ingest-active-choices">
          Template:{' '}
          {templatePath
            ? `${baseName(templatePath)} (${templateMode === 'replace' ? 'replace existing' : 'fill empty'})`
            : 'None'}{' '}
          · Preset: {presetName}
        </p>
        {listedSources.length === 0 && (
          <p className={styles.empty}>No other sources. Add a folder or FTP server in Sources….</p>
        )}
        <ul className={styles.list}>
          {listedSources.map((source) => {
            const run = state.ingest[source.id];
            return (
              <li key={source.id} className={styles.source}>
                <Dot tone={runTone(run)} />
                <span className={styles.name}>{source.name}</span>
                <span className={styles.kind}>{source.kind}</span>
                <RunStatus source={source} run={run} />
                {source.kind === 'folder' || source.kind === 'card' ? (
                  <div className={styles.sourceFilters}>
                    <IngestSourceFilters source={source} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      <section className={styles.settings}>
        <h3 className={styles.title}>Ingest settings</h3>
        <div className={styles.form}>
          <IngestSection />
        </div>
      </section>
      <div className={styles.bar2}>
        <ActionBar
          left={
            <span className={barStyles.summary}>
              Ingest always copies to the destination folder. Library and Develop open those copies,
              never the card.
            </span>
          }
          right={
            <>
              <Button onClick={() => store.openDialog('sources')}>Sources…</Button>
              <Button onClick={() => store.openDialog('destinations')}>Destinations…</Button>
            </>
          }
        />
      </div>
    </div>
  );
}
