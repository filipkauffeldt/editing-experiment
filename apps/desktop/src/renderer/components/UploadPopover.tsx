import type { UploadItem } from '@ee/contracts';
import { useEffect, useRef } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { CheckIcon, ClockIcon, CrossIcon, UploadIcon } from './icons';
import styles from './UploadPopover.module.css';

const STATE_LABEL: Record<UploadItem['state'], string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const PRIORITY: Record<UploadItem['state'], number> = {
  failed: 0,
  uploading: 1,
  queued: 2,
  cancelled: 3,
  done: 4,
};

function stateIcon(state: UploadItem['state']) {
  if (state === 'done') return <CheckIcon size={10} />;
  if (state === 'failed') return <CrossIcon size={10} />;
  if (state === 'uploading') return <UploadIcon size={10} />;
  return <ClockIcon size={10} />;
}

const formatBytes = (bytes: number): string => {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
};

/** Queue details opened from the status bar. */
export function UploadPopover({ onClose }: { onClose(): void }) {
  const store = useAppStore();
  const state = useAppState();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onClose]);

  const items = [...state.uploads].sort((left, right) => {
    const byState = PRIORITY[left.state] - PRIORITY[right.state];
    return byState !== 0 ? byState : left.localPath.localeCompare(right.localPath);
  });

  return (
    <div className={styles.popover} ref={ref} role="dialog" aria-label="Upload queue">
      <header className={styles.header}>
        <span>Upload queue</span>
        <span className={styles.headerCount}>{items.length} files</span>
      </header>
      <div className={styles.list}>
        {items.length === 0 && <div className={styles.empty}>Nothing has been exported yet.</div>}
        {items.map((item) => {
          const photo = state.photos.find((candidate) => candidate.id === item.photoId);
          const destination = state.destinations.find(
            (candidate) => candidate.id === item.destinationId,
          );
          const percent =
            item.bytesTotal > 0 ? Math.round((item.bytesSent / item.bytesTotal) * 100) : 0;
          return (
            <div key={item.id} className={styles.item}>
              <span className={`${styles.stateIcon} ${styles[item.state]}`}>
                {stateIcon(item.state)}
              </span>
              <div className={styles.details}>
                <div className={styles.row}>
                  <span className={styles.name}>{photo?.fileName ?? item.photoId}</span>
                  <span className={`${styles.stateLabel} ${styles[item.state]}`}>
                    {STATE_LABEL[item.state]}
                  </span>
                </div>
                <div className={styles.destination}>
                  {destination?.name ?? item.destinationId} · {item.remotePath}
                </div>
                {item.state === 'uploading' && (
                  <div className={styles.progress}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                )}
                {item.state === 'failed' && item.error && (
                  <div className={styles.error}>{item.error}</div>
                )}
                {item.state === 'uploading' && (
                  <div className={styles.bytes}>
                    {formatBytes(item.bytesSent)} / {formatBytes(item.bytesTotal)}
                  </div>
                )}
              </div>
              <div className={styles.actions}>
                {(item.state === 'failed' || item.state === 'cancelled') && (
                  <button type="button" onClick={() => void store.retryUpload(item.id)}>
                    Retry
                  </button>
                )}
                {(item.state === 'queued' || item.state === 'uploading') && (
                  <button type="button" onClick={() => void store.cancelUpload(item.id)}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
