import { useMemo } from 'react';
import { COLLECTIONS, baseName, inCollection, libraryFolders } from '../library';
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
  const destination = state.settings?.ingest.destination.path;
  const running = state.sources.flatMap((source) => {
    const run = state.ingest[source.id];
    return run && run.state === 'running' ? [{ source, run }] : [];
  });
  const everything = library.folder === undefined && library.collection === undefined;

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

      {running.length > 0 && (
        <>
          <h3 className={styles.title}>
            Ingesting{destination ? ` → ${baseName(destination)}` : ''}
          </h3>
          <ul className={styles.list} data-testid="library-ingesting">
            {running.map(({ source, run }) => {
              const percent =
                run.filesTotal > 0 ? Math.min(100, (run.filesDone / run.filesTotal) * 100) : 0;
              return (
                <li key={source.id} className={styles.progress}>
                  <span className={styles.name}>{source.name}</span>
                  <span className={`${styles.count} mono`}>
                    {run.filesDone}/{run.filesTotal}
                  </span>
                  <span className={styles.bar}>
                    <span style={{ width: `${percent}%` }} />
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h3 className={styles.title}>Collections</h3>
      <ul className={styles.list}>
        {COLLECTIONS.map((collection) => (
          <li key={collection.id}>
            <button
              type="button"
              className={`${styles.row} ${library.collection === collection.id ? styles.active : ''}`}
              onClick={() => store.setLibraryCollection(collection.id)}
            >
              <span className={styles.name}>{collection.label}</span>
              <span className={`${styles.count} mono`}>
                {state.photos.filter((photo) => inCollection(photo, collection.id)).length}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
