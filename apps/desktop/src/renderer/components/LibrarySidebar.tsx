import { useMemo } from 'react';
import { libraryFolders } from '../library';
import { useAppState, useAppStore } from '../store-context';
import styles from './LibrarySidebar.module.css';

/**
 * Folders are the local ingest copies only: they come from the photos' own paths, never from
 * the configured sources, so a card or an FTP server can not show up here. Editing only ever
 * happens on those copies.
 */
export function LibrarySidebar({ className }: { className?: string }) {
  const store = useAppStore();
  const state = useAppState();
  const { library } = state;
  const folders = useMemo(() => libraryFolders(state.photos), [state.photos]);
  const everything = library.folder === undefined;

  return (
    <aside className={`${styles.side} ${className ?? ''}`} data-testid="library-sidebar">
      <h3 className={styles.title}>Folders</h3>
      <ul className={styles.list} data-testid="library-folders">
        <li>
          <button
            type="button"
            className={`${styles.row} ${everything ? styles.active : ''}`}
            onClick={() => store.setLibraryFolder(undefined)}
          >
            <span className={styles.name}>All photos</span>
            <span className={`${styles.count} mono`}>{state.photos.length}</span>
          </button>
        </li>
        {folders.map((folder) => (
          <li key={folder.path}>
            <button
              type="button"
              className={`${styles.row} ${library.folder === folder.path ? styles.active : ''}`}
              title={folder.path}
              onClick={() => store.setLibraryFolder(folder.path)}
            >
              <span className={styles.name}>{folder.name}</span>
              <span className={`${styles.count} mono`}>{folder.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
