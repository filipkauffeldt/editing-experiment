import type { PingResult, SystemInfo } from '@ee/contracts';
import { useEffect, useState } from 'react';
import { ee } from '../ee';
import { activePhoto, exportStatusText, sourceLabel, uploadSummary } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { GearIcon, UploadIcon, WarningIcon } from './icons';
import { UploadPopover } from './UploadPopover';
import styles from './StatusBar.module.css';

interface StatusBarProps {
  className?: string;
  photoCount: number;
  loadError?: string;
}

interface Backend {
  info: SystemInfo;
  ping: PingResult;
  roundTripMs: number;
}

/** Top bar: ingest progress, upload queue, template drift, health and settings. */
export function StatusBar({ className, photoCount, loadError }: StatusBarProps) {
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
  const photo = activePhoto(state);
  const differs = photo?.status.metadataDiffersFromTemplate ?? false;
  const exportStatus = exportStatusText(state);

  return (
    <div className={`${styles.bar} ${className ?? ''}`} data-testid="status-bar">
      <strong className={styles.brand}>Editing Experiment</strong>
      {backend?.info.mock && <span className={styles.mock}>MOCK</span>}

      <span
        className={`${styles.health} ${healthError ? styles.healthError : ''}`}
        title={
          backend
            ? `jobs pid ${backend.ping.jobsPid} · core ${backend.info.coreVersion} · round trip ${backend.roundTripMs} ms`
            : (healthError ?? 'connecting to jobs process…')
        }
      >
        <span className={styles.healthDot} />
        {backend ? `jobs ${backend.ping.jobsPid}` : 'jobs…'}
      </span>

      <div className={styles.ingestList}>
        {state.sources.map((source) => {
          const run = state.ingest[source.id];
          if (!run) return null;
          const percent =
            run.filesTotal > 0
              ? Math.min(100, Math.round((run.filesDone / run.filesTotal) * 100))
              : 0;
          const active = run.state === 'running';
          return (
            <span
              key={source.id}
              className={`${styles.ingest} ${run.state === 'finished' ? styles.ingestDone : ''} ${
                run.state === 'failed' ? styles.ingestFailed : ''
              }`}
              title={`${sourceLabel(state.sources, source.id)} · ${run.filesDone}/${run.filesTotal} files`}
            >
              <span className={styles.ingestName}>{source.name}</span>
              <span className={styles.ingestBar}>
                <span style={{ width: `${percent}%` }} className={active ? styles.pulse : ''} />
              </span>
              <span className={styles.ingestCount}>
                {run.state === 'finished' ? 'done' : `${run.filesDone}/${run.filesTotal}`}
              </span>
            </span>
          );
        })}
      </div>

      <span className={styles.spacer} />

      {loadError && <span className={styles.error}>{loadError}</span>}

      {exportStatus && (
        <span className={styles.exportProgress} data-testid="export-progress">
          <span className={styles.exportLabel}>{exportStatus}</span>
        </span>
      )}

      {differs && (
        <span
          className={styles.diff}
          title="This photo's metadata differs from the ingest template"
        >
          <WarningIcon size={11} /> Metadata differs
        </span>
      )}

      <div className={styles.uploadWrap}>
        <button
          type="button"
          className={`${styles.uploadButton} ${summary.failed > 0 ? styles.uploadFailed : ''}`}
          onClick={() => setUploadOpen((open) => !open)}
          aria-expanded={uploadOpen}
          data-testid="upload-summary"
        >
          <UploadIcon size={11} />
          <span>
            {summary.active > 0
              ? `${summary.active} active`
              : summary.failed > 0
                ? 'Upload failed'
                : `${summary.done} uploaded`}
          </span>
          {summary.failed > 0 && (
            <span className={styles.failedCount}>{summary.failed} failed</span>
          )}
        </button>
        {uploadOpen && <UploadPopover onClose={() => setUploadOpen(false)} />}
      </div>

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

      <span className={styles.count} title={`${photoCount} of ${state.photos.length} photos shown`}>
        {photoCount} / {state.photos.length}
      </span>
    </div>
  );
}
