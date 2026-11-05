import type { PingResult, SystemInfo } from '@ee/contracts';
import { useEffect, useState } from 'react';
import { ee } from '../ee';
import { exportStatusText, uploadSummary, type AppModule } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { GearIcon } from './icons';
import { UploadPopover } from './UploadPopover';
import { Dot } from './ui/Dot';
import styles from './TopBar.module.css';

interface Backend {
  info: SystemInfo;
  ping: PingResult;
  roundTripMs: number;
}

const TABS: { id: AppModule; label: string; hint: string }[] = [
  { id: 'ingest', label: 'Ingest', hint: 'Ingest sources and progress' },
  { id: 'library', label: 'Library', hint: 'Library grid (G)' },
  { id: 'develop', label: 'Develop', hint: 'Develop (D)' },
];

/** Top bar: app mark, module switch and right-aligned status dots. */
export function TopBar({ className, loadError }: { className?: string; loadError?: string }) {
  const store = useAppStore();
  const state = useAppState();
  const [backend, setBackend] = useState<Backend>();
  const [healthError, setHealthError] = useState<string>();
  const [uploadOpen, setUploadOpen] = useState(false);

  useEffect(() => {
    const started = performance.now();
    Promise.all([ee.invoke('system:info'), ee.invoke('system:ping', { message: 'status-bar' })])
      .then(([info, ping]) =>
        setBackend({ info, ping, roundTripMs: Math.round(performance.now() - started) }),
      )
      .catch((cause: unknown) =>
        setHealthError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  const summary = uploadSummary(state.uploads);
  const exportStatus = exportStatusText(state);
  const runs = state.sources.flatMap((source) => {
    const run = state.ingest[source.id];
    return run ? [{ source, run }] : [];
  });
  const running = runs.filter(({ run }) => run.state === 'running');
  const watching = runs.filter(
    ({ run, source }) =>
      run.state === 'watching' && (source.kind === 'ftp' || source.kind === 'sftp'),
  );
  const filesDone = running.reduce((sum, { run }) => sum + run.filesDone, 0);
  const filesTotal = running.reduce((sum, { run }) => sum + run.filesTotal, 0);
  // Cancelled rows were never going to be sent, so they are no part of the queue's size.
  const uploadCount = state.uploads.filter((upload) => upload.state !== 'cancelled').length;
  // The failed dot opens the upload queue, so it counts failed uploads only. A failed
  // ingest run stays on its source row in Ingest, with the job error toast.
  const failed = summary.failed;
  const active: AppModule = state.retouch ? 'develop' : state.module;

  const choose = (tab: AppModule): void => {
    // Retouch is Develop with a session open, so the Develop tab is also the way out of it.
    if (tab === 'develop' && state.retouch) void store.requestExitRetouch();
    else store.setModule(tab);
  };

  return (
    <div className={`${styles.bar} ${className ?? ''}`} data-testid="status-bar">
      <span
        className={styles.mark}
        title={
          backend
            ? `jobs pid ${backend.ping.jobsPid} · core ${backend.info.coreVersion} · round trip ${backend.roundTripMs} ms`
            : (healthError ?? 'connecting to jobs process…')
        }
        data-health={healthError ? 'error' : backend ? 'ok' : 'connecting'}
      />

      <nav className={styles.modules} role="tablist" aria-label="Module">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={`${styles.module} ${active === tab.id ? styles.moduleActive : ''}`}
            title={tab.hint}
            onClick={() => choose(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {backend?.info.mock && <span className={styles.mock}>MOCK</span>}
      {loadError && <span className={styles.error}>{loadError}</span>}

      <span className={styles.spacer} />

      {exportStatus && (
        <span className={styles.exportProgress} data-testid="export-progress">
          {exportStatus}
        </span>
      )}

      {running.length > 0 && (
        <span
          className={`${styles.status} ${styles.statusOn}`}
          title={runs.map(({ source, run }) => `${source.name}: ${run.state}`).join('\n')}
          data-testid="ingest-status"
        >
          <Dot tone="ok" />
          Ingesting <span className="mono">{`${filesDone} of ${filesTotal}`}</span>
        </span>
      )}

      {watching.length > 0 && (
        <span className={`${styles.status} ${styles.statusOn}`} data-testid="watching-status">
          <Dot tone="ok" />
          Watching FTP
        </span>
      )}

      <div className={styles.uploadWrap}>
        {summary.active > 0 && (
          <button
            type="button"
            className={`${styles.status} ${styles.statusButton} ${styles.statusOn}`}
            onClick={() => setUploadOpen((open) => !open)}
            aria-expanded={uploadOpen}
            data-testid="upload-summary"
          >
            <Dot tone="ok" />
            Sending <span className="mono">{`${summary.active} of ${uploadCount}`}</span>
          </button>
        )}
        {uploadOpen && <UploadPopover onClose={() => setUploadOpen(false)} />}
      </div>

      {failed > 0 && (
        <button
          type="button"
          className={`${styles.status} ${styles.statusButton} ${styles.statusOn}`}
          onClick={() => setUploadOpen(true)}
          title="Show failed uploads"
          data-testid="failed-summary"
        >
          <Dot tone="error" />
          <span className="mono">{failed}</span> failed
        </button>
      )}

      <button
        type="button"
        className={styles.iconButton}
        title="Shortcuts (?)"
        onClick={() => store.toggleShortcuts(true)}
      >
        ?
      </button>

      <button
        type="button"
        className={styles.iconButton}
        title="Settings"
        onClick={() => store.openDialog('sources')}
        data-testid="open-settings"
      >
        <GearIcon size={12} />
      </button>
    </div>
  );
}
