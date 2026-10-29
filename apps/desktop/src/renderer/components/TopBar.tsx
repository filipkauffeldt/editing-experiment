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

type Tab = AppModule | 'retouch';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'ingest', label: 'Ingest', hint: 'Ingest sources and progress' },
  { id: 'library', label: 'Library', hint: 'Library grid (G)' },
  { id: 'develop', label: 'Develop', hint: 'Develop (D)' },
  { id: 'retouch', label: 'Retouch', hint: 'Retouch (R)' },
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
  // Sending is already a dot; only a running export needs words.
  const exportText = exportStatusText(state);
  const exportStatus = exportText?.startsWith('Exporting') ? exportText : undefined;
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
  const failed = summary.failed + runs.filter(({ run }) => run.state === 'failed').length;
  const active: Tab = state.retouch ? 'retouch' : state.module;

  const choose = (tab: Tab): void => {
    if (tab === 'retouch') store.openRetouchModule();
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

      <span
        className={`${styles.status} ${running.length > 0 ? styles.statusOn : ''}`}
        title={runs.map(({ source, run }) => `${source.name}: ${run.state}`).join('\n')}
      >
        <Dot tone={running.length > 0 ? 'ok' : 'idle'} />
        {running.length > 0 ? (
          <>
            ingesting <span className="mono">{`${filesDone}/${filesTotal}`}</span>
          </>
        ) : (
          'ingest idle'
        )}
      </span>

      <span className={`${styles.status} ${watching.length > 0 ? styles.statusOn : ''}`}>
        <Dot tone={watching.length > 0 ? 'ok' : 'idle'} />
        FTP watching
        {watching.length > 1 && <span className="mono">{watching.length}</span>}
      </span>

      <div className={styles.uploadWrap}>
        <button
          type="button"
          className={`${styles.status} ${styles.statusButton} ${summary.active > 0 ? styles.statusOn : ''}`}
          onClick={() => setUploadOpen((open) => !open)}
          aria-expanded={uploadOpen}
          data-testid="upload-summary"
        >
          <Dot tone={summary.active > 0 ? 'ok' : 'idle'} />
          sending <span className="mono">{summary.active}</span>
        </button>
        {uploadOpen && <UploadPopover onClose={() => setUploadOpen(false)} />}
      </div>

      <button
        type="button"
        className={`${styles.status} ${styles.statusButton} ${failed > 0 ? styles.statusOn : ''}`}
        onClick={() => setUploadOpen(true)}
        title="Show failed uploads"
      >
        <Dot tone={failed > 0 ? 'error' : 'idle'} />
        failed <span className="mono">{failed}</span>
      </button>

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
