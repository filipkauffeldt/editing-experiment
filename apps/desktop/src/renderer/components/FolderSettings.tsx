import { Button } from './ui/Button';
import styles from './FolderSettings.module.css';

export { styles as folderSettingsStyles };

/**
 * The folders a search looks in, as Settings → Profiles and Settings → Presets show them: Adobe's own
 * (tagged, not removable) and the ones the user added (removable). Nothing in a folder is changed.
 */
export function FolderList({
  adobe,
  added,
  empty,
  onRemove,
}: {
  adobe: readonly string[];
  added: readonly string[];
  empty: string;
  onRemove(folder: string): void;
}) {
  return (
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
            <Button size="small" onClick={() => onRemove(folder)}>
              Remove
            </Button>
          </div>
        ))}
        {adobe.length === 0 && added.length === 0 && (
          <div className={styles.folder}>
            <span className={styles.tag}>{empty}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Files (or folders) a scan could not use, each with its path and the reason; the first 25. */
export function ProblemList({
  problems,
}: {
  problems: readonly { path: string; reason: string }[];
}) {
  if (problems.length === 0) return null;
  return (
    <div>
      <h3 className={styles.heading}>Could not be used</h3>
      <ul className={styles.problems}>
        {problems.slice(0, 25).map((problem) => (
          <li key={problem.path}>
            <span className={`${styles.problemPath} mono`} title={problem.path}>
              {problem.path}
            </span>
            {problem.reason}
          </li>
        ))}
        {problems.length > 25 && <li>…and {problems.length - 25} more.</li>}
      </ul>
    </div>
  );
}
