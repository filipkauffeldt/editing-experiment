import type { SettingsFolderChoice, SettingsFolderInfo } from '@ee/contracts';
import { useEffect, useState } from 'react';
import { ee } from '../ee';
import { useAppStore } from '../store-context';
import styles from './SettingsDialog.module.css';

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The one folder the shared settings live in: what every computer has in common and
 * imported develop presets. Paths that belong to this computer stay in `userData`.
 */
export function SettingsFolderSettings() {
  const store = useAppStore();
  const [info, setInfo] = useState<SettingsFolderInfo>();
  const [offer, setOffer] = useState<SettingsFolderChoice>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void store.loadSettingsFolder().then(
      (loaded) => {
        if (!cancelled) setInfo(loaded);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const choose = (): Promise<void> =>
    run(async () => {
      const [path] = await ee.invoke('dialog:pick', {
        kind: 'folder',
        title: 'Settings folder',
      });
      if (!path) return;
      const choice = await store.inspectSettingsFolder(path);
      if (choice.problem !== undefined) {
        setOffer(undefined);
        setError(choice.problem);
        return;
      }
      if (choice.hasSettings) {
        setOffer(undefined);
        setInfo(await store.useSettingsFolder(path));
        setStatus(`Using the settings in ${path}.`);
        return;
      }
      setOffer(choice);
    });

  const copy = (): Promise<void> =>
    run(async () => {
      if (!offer) return;
      setInfo(await store.copySettingsToFolder(offer.path));
      setStatus(`Copied the settings to ${offer.path}.`);
      setOffer(undefined);
    });

  const startEmpty = (): Promise<void> =>
    run(async () => {
      if (!offer) return;
      setInfo(await store.useSettingsFolder(offer.path));
      setStatus(`Using the empty folder ${offer.path}.`);
      setOffer(undefined);
    });

  return (
    <div className={styles.formWide} data-testid="settings-folder-settings">
      <div className={styles.field}>
        <span className={styles.label}>Settings folder</span>
        <p className={styles.hint}>
          Sources, destinations, ingest options, export presets and imported develop presets live
          here. Sync this folder between computers. Paths that belong to this computer stay in its
          own profile.
        </p>
        <div className={styles.fileRow}>
          <span className={`${styles.filePath} mono`} data-testid="settings-folder-path">
            {info?.path ?? '…'}
          </span>
          {info?.isDefault === true && <span className={styles.kindPill}>Default</span>}
        </div>
        {info?.problem !== undefined && <p className={styles.error}>{info.problem}</p>}
        <div className={styles.addRow}>
          <button
            type="button"
            className={styles.button}
            data-testid="choose-settings-folder"
            disabled={busy}
            onClick={() => void choose()}
          >
            Choose folder…
          </button>
        </div>
      </div>

      {offer && (
        <div className={styles.field} data-testid="settings-folder-offer">
          <p className={styles.hint}>
            {offer.path} is empty. Copy the current settings there, or use it empty.
          </p>
          <div className={styles.addRow}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => void copy()}
            >
              Copy settings
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => void startEmpty()}
            >
              Use empty folder
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => setOffer(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status && <p className={styles.status}>{status}</p>}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
