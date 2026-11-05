import { useEffect } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { Button } from './ui/Button';
import { FolderList, ProblemList, folderSettingsStyles as styles } from './FolderSettings';

/**
 * Settings → Presets: where the app looks for develop presets. The files are Adobe's (or the
 * user's) and are read where they are, never changed or copied; a changed file is read again and a
 * removed one leaves the list when it is rescanned.
 */
export function PresetsSettings() {
  const store = useAppStore();
  const state = useAppState();
  const index = state.presetIndex;
  const added = state.settings?.presetFolders ?? [];

  useEffect(() => {
    void store.loadPresetIndex(true);
  }, [store]);

  // The scanned folders that are not ones the user added are Adobe's own.
  const adobe = (index?.folders ?? []).filter((f) => !added.includes(f));
  const count = index?.presets.length ?? 0;

  return (
    <div className={styles.body} data-testid="presets-settings">
      <p className={styles.lead}>
        Develop presets from Lightroom Classic and Camera Raw (.xmp and .lrtemplate) are Adobe’s or
        your own files and stay where they are; the app only reads them, grouped by the folders and
        groups you made. macOS and Windows: the Camera Raw and Lightroom preset folders are searched
        when they exist. If Lightroom Classic stores presets with the catalog, add the{' '}
        <span className="mono">Lightroom Settings</span> folder next to it. Lightroom (cloud)
        presets are not files on this machine: export them as .xmp and add that folder. Linux: copy
        the folder over and add it here.
      </p>

      <FolderList
        adobe={adobe}
        added={added}
        empty="No preset folder yet."
        onRemove={(folder) => void store.removePresetFolder(folder)}
      />

      <div className={styles.actions}>
        <Button onClick={() => void store.addPresetFolder()}>Add folder…</Button>
        <Button onClick={() => void store.loadPresetIndex(true)}>Rescan</Button>
      </div>

      {index && (
        <p className={styles.lead} data-testid="presets-summary">
          {count} preset{count === 1 ? '' : 's'}
          {index.problems.length > 0 ? `, ${index.problems.length} could not be used` : ''}.
        </p>
      )}

      {index && <ProblemList problems={index.problems} />}
    </div>
  );
}
