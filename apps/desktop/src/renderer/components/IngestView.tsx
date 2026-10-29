import { useAppState, useAppStore } from '../store-context';
import { ActionBar, barStyles } from './ActionBar';
import { Dot } from './ui/Dot';
import { Button } from './ui/Button';
import { IngestSection } from './SettingsDialog';
import styles from './IngestView.module.css';

/** Ingest: every source with its progress, and the ingest settings (destination, rename, template). */
export function IngestView() {
  const store = useAppStore();
  const state = useAppState();
  return (
    <div className={styles.view} data-testid="ingest-view">
      <section className={styles.sources}>
        <h3 className={styles.title}>Sources</h3>
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
                <span className={`${styles.state} mono`}>
                  {run
                    ? run.state === 'finished'
                      ? 'done'
                      : `${run.state} ${run.filesDone}/${run.filesTotal}`
                    : 'not started'}
                </span>
                <span className={styles.bar}>
                  <span style={{ width: `${percent}%` }} />
                </span>
                {run?.error && <span className={styles.error}>{run.error}</span>}
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
