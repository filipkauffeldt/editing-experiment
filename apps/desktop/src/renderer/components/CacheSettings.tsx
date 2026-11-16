import { useEffect, useState } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { Button } from './ui/Button';
import styles from './SettingsDialog.module.css';

const GB = 1024 ** 3;
const DEFAULT_LIMIT_GB = 20;
const MIN_LIMIT_GB = 1;
const MAX_LIMIT_GB = 1024;

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${bytes} B`;
}

/**
 * One number for the disposable thumbnail and preview caches, this computer only.
 * Lowering it evicts old previews first; the grid keeps its small thumbnails longer.
 */
export function CacheSettings() {
  const store = useAppStore();
  const state = useAppState();
  const stats = state.cacheStats;
  const [draft, setDraft] = useState(
    String(Math.round((state.settings?.cacheLimitBytes ?? DEFAULT_LIMIT_GB * GB) / GB)),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    void store.loadCacheStats().catch(() => undefined);
  }, [store]);

  const apply = async (): Promise<void> => {
    const gigabytes = Math.min(
      MAX_LIMIT_GB,
      Math.max(MIN_LIMIT_GB, Math.round(Number(draft) || DEFAULT_LIMIT_GB)),
    );
    setBusy(true);
    setStatus(undefined);
    try {
      const next = await store.setCacheLimit(gigabytes * GB);
      setDraft(String(Math.round(next.limitBytes / GB)));
      setStatus('Saved on this computer.');
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setStatus(undefined);
    try {
      await store.clearCache();
      setStatus('Cache cleared. Thumbnails and previews are made again when needed.');
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.form} data-testid="cache-settings">
      <p className={styles.status}>
        Thumbnails and previews are disposable. Removing a cache file makes it again from the photo
        when it is shown, so a smaller cache only costs a little time.
      </p>
      <label className={styles.field}>
        <span className={styles.label}>
          Cache size limit (GB), thumbnails and previews together
        </span>
        <span className={styles.inputRow}>
          <input
            className={styles.input}
            type="number"
            min={MIN_LIMIT_GB}
            max={MAX_LIMIT_GB}
            step={1}
            value={draft}
            data-testid="cache-limit"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void apply()}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void apply();
            }}
          />
          <Button disabled={busy} onClick={() => void apply()}>
            Save
          </Button>
        </span>
      </label>
      <p className={styles.status} data-testid="cache-use">
        In use: {formatBytes(stats?.bytes ?? 0)} ({formatBytes(stats?.thumbBytes ?? 0)} thumbnails,{' '}
        {formatBytes(stats?.previewBytes ?? 0)} previews)
      </p>
      <div className={styles.formActions}>
        <Button disabled={busy} data-testid="cache-clear" onClick={() => void clear()}>
          Clear cache
        </Button>
        <span className={styles.spacer} />
      </div>
      {status && <p className={styles.status}>{status}</p>}
    </div>
  );
}
