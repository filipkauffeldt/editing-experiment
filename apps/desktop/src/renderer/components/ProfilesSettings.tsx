import { useEffect } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { Button } from './ui/Button';
import { FolderList, ProblemList, folderSettingsStyles as styles } from './FolderSettings';

/**
 * Settings → Profiles: where the app looks for camera profiles. The files are Adobe's (or the
 * user's) and are read where they are; nothing is copied. Adobe's own folders are searched when
 * they exist on this machine; on Linux the user copies the folder over and adds it here.
 */
export function ProfilesSettings() {
  const store = useAppStore();
  const state = useAppState();
  const index = state.profileIndex;
  const added = state.settings?.profileFolders ?? [];

  useEffect(() => {
    void store.loadProfileIndex();
  }, [store]);

  const cameras = index?.profiles.filter((p) => p.kind === 'camera').length ?? 0;
  const looks = index?.profiles.filter((p) => p.kind === 'look').length ?? 0;
  // The scanned folders that are not ones the user added are Adobe's own.
  const adobe = (index?.folders ?? []).filter((f) => !added.includes(f));

  return (
    <div className={styles.body} data-testid="profiles-settings">
      <p className={styles.lead}>
        Camera profiles (Adobe Standard, Adobe Color, Camera Standard…) are Adobe’s files and are
        not part of this app. It reads the DNG profiles (.dcp) and XMP profiles (.xmp) it finds
        below these folders, where they are. macOS and Windows: Adobe’s own folders are searched
        when they exist (install Adobe DNG Converter, which is free, to get the profiles). Linux:
        copy the <span className="mono">CameraProfiles</span> folder from a Mac or Windows machine
        and add it here.
      </p>

      <FolderList
        adobe={adobe}
        added={added}
        empty="No profile folder yet."
        onRemove={(folder) => void store.removeProfileFolder(folder)}
      />

      <div className={styles.actions}>
        <Button onClick={() => void store.addProfileFolder()}>Add folder…</Button>
        <Button onClick={() => void store.loadProfileIndex(true)}>Rescan</Button>
      </div>

      {index && (
        <p className={styles.lead} data-testid="profiles-summary">
          {cameras} camera profile{cameras === 1 ? '' : 's'}, {looks} XMP profile
          {looks === 1 ? '' : 's'}
          {index.problems.length > 0 ? `, ${index.problems.length} could not be used` : ''}.
        </p>
      )}

      {index && <ProblemList problems={index.problems} />}
    </div>
  );
}
