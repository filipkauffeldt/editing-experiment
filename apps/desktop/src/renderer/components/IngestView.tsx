import type { SourceConfig } from '@ee/contracts';
import { useEffect, useState } from 'react';
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
  return (
    <div className={styles.view} data-testid="ingest-view">
      <section className={styles.sources}>
        <h3 className={styles.title}>Sources</h3>
        <p className={styles.activeChoices} data-testid="ingest-active-choices">
          Template:{' '}
          {templatePath
            ? `${baseName(templatePath)} (${templateMode === 'replace' ? 'replace existing' : 'fill empty'})`
            : 'None'}{' '}
          · Preset: {presetName}
        </p>
        {state.sources.length === 0 && (
          <p className={styles.empty}>No sources yet. Add a card, folder or FTP server.</p>
        )}
        <ul className={styles.list}>
          {state.sources.map((source) => {
            const run = state.ingest[source.id];
            const percent =
              run && run.filesTotal > 0 ? Math.min(100, (run.filesDone / run.filesTotal) * 100) : 0;
            return (
              <li key={source.id} className={styles.source}>
                <Dot
                  tone={
                    run?.state === 'failed'
                      ? 'error'
                      : run?.state === 'running' || run?.state === 'watching'
                        ? 'ok'
                        : 'idle'
                  }
                />
                <span className={styles.name}>{source.name}</span>
                <span className={styles.kind}>{source.kind}</span>
                <span className={`${styles.state} mono`}>{progressText(source, run)}</span>
                <span className={styles.bar}>
                  <span style={{ width: `${percent}%` }} />
                </span>
                {source.kind === 'folder' || source.kind === 'card' ? (
                  <div className={styles.sourceFilters}>
                    <IngestSourceFilters source={source} />
                  </div>
                ) : null}
                {run?.error && <span className={styles.error}>{run.error}</span>}
                {run?.warning && <span className={styles.warning}>{run.warning}</span>}
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
