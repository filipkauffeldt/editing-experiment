import { useEffect } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { Button } from './ui/Button';
import styles from './ProfilesSettings.module.css';

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

      <div>
        <h3 className={styles.heading}>Folders</h3>
        <div className={styles.folders}>
          {adobe.map((folder) => (
            <div key={folder} className={styles.folder}>
              <span className={`${styles.path} mono`} title={folder}>
                {folder}
              </span>
              <span className={styles.tag}>Adobe</span>
            </div>
          ))}
          {added.map((folder) => (
            <div key={folder} className={styles.folder}>
              <span className={`${styles.path} mono`} title={folder}>
                {folder}
              </span>
              <Button size="small" onClick={() => void store.removeProfileFolder(folder)}>
                Remove
              </Button>
            </div>
          ))}
          {adobe.length === 0 && added.length === 0 && (
            <div className={styles.folder}>
              <span className={styles.tag}>No profile folder yet.</span>
            </div>
          )}
        </div>
      </div>

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

      {index && index.problems.length > 0 && (
        <div>
          <h3 className={styles.heading}>Could not be used</h3>
          <ul className={styles.problems}>
            {index.problems.slice(0, 25).map((problem) => (
              <li key={problem.path}>
                <span className={`${styles.problemPath} mono`} title={problem.path}>
                  {problem.path}
                </span>
                {problem.reason}
              </li>
            ))}
            {index.problems.length > 25 && <li>…and {index.problems.length - 25} more.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
