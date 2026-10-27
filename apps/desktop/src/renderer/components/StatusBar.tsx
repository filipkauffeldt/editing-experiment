import type { PingResult, SystemInfo } from '@ee/contracts';
import { useEffect, useState } from 'react';
import { ee } from '../ee';
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

/** Top bar. Doubles as the health check of the renderer → main → jobs → core path. */
export function StatusBar({ className, photoCount, loadError }: StatusBarProps) {
  const [backend, setBackend] = useState<Backend>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const started = performance.now();
    Promise.all([ee.invoke('system:info'), ee.invoke('system:ping', { message: 'status-bar' })])
      .then(([info, ping]) =>
        setBackend({ info, ping, roundTripMs: Math.round(performance.now() - started) }),
      )
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  return (
    <div className={`${styles.bar} ${className ?? ''}`} data-testid="status-bar">
      <strong>Editing Experiment</strong>
      {backend ? (
        <>
          <span className={styles.ok}>● jobs pid {backend.ping.jobsPid}</span>
          <span>round trip {backend.roundTripMs} ms</span>
          <span>core {backend.info.coreVersion}</span>
        </>
      ) : (
        <span className={error ? styles.error : undefined}>
          {error ?? 'connecting to jobs process…'}
        </span>
      )}
      <span className={styles.spacer} />
      {loadError && <span className={styles.error}>{loadError}</span>}
      <span>{photoCount} photos</span>
      {backend?.info.mock && <span className={styles.mock}>MOCK</span>}
    </div>
  );
}
