import { useEffect, useMemo, useState } from 'react';
import { baseName, libraryFolders, type LibraryFolder } from '../library';
import { useAppState, useAppStore } from '../store-context';
import { Button } from './ui/Button';
import styles from './LibrarySidebar.module.css';

interface FolderMenuState {
  x: number;
  y: number;
  folder: LibraryFolder;
}

/**
 * Folders come from the photos themselves: ingest copies and folders the user added in place.
 * Nothing here is a configured source. Added folders can be rescanned or removed from the
 * Library; an added folder is worked on where it is, so edits write sidecars and JPEG metadata
 * in that folder.
 */
export function LibrarySidebar({ className }: { className?: string }) {
  const store = useAppStore();
  const state = useAppState();
  const { library, addedFolders, folderImports } = state;
  const folders = useMemo(() => libraryFolders(state.photos), [state.photos]);
  const everything = library.folder === undefined;
  const [menu, setMenu] = useState<FolderMenuState>();
  const running = Object.values(folderImports).filter((run) => run.state === 'running');

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(undefined);
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-folder-menu]')) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const openMenu = (folder: LibraryFolder, x: number, y: number): void => {
    setMenu({
      folder,
      x: Math.min(x, window.innerWidth - 250),
      y: Math.min(y, window.innerHeight - 110),
    });
  };

  return (
    <aside className={`${styles.side} ${className ?? ''}`} data-testid="library-sidebar">
      <div className={styles.heading}>
        <h3 className={styles.title}>Folders</h3>
        <Button
          size="small"
          variant="ghost"
          data-testid="library-add-folder"
          title="Photos stay where they are. Edits write XMP sidecars and JPEG metadata in the folder."
          onClick={() => void store.addLibraryFolder()}
        >
          Add folder…
        </Button>
      </div>
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
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(folder, event.clientX, event.clientY);
              }}
            >
              <span className={styles.name}>{folder.name}</span>
              <span className={`${styles.count} mono`}>{folder.count}</span>
            </button>
          </li>
        ))}
      </ul>
      {running.length > 0 && (
        <div className={styles.runs} data-testid="folder-imports">
          {running.map((run) => (
            <div key={run.jobId} className={styles.run} data-testid="folder-import">
              <div className={styles.runText}>
                <span className={styles.name} title={run.root}>
                  {run.mode === 'add' ? 'Adding' : 'Rescanning'} {baseName(run.root)}
                </span>
                <span className={`${styles.count} mono`}>
                  {run.filesTotal === 0 ? '…' : `${run.filesDone}/${run.filesTotal}`}
                </span>
              </div>
              <Button
                size="small"
                data-testid="folder-import-stop"
                onClick={() => void store.stopFolderImport(run.jobId)}
              >
                Stop
              </Button>
            </div>
          ))}
        </div>
      )}
      {menu && (
        <div
          className={styles.menu}
          role="menu"
          aria-label={menu.folder.name}
          data-testid="folder-menu"
          data-folder-menu
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {addedFolders.includes(menu.folder.path) && (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              data-testid="folder-menu-rescan"
              onClick={() => {
                const folder = menu.folder;
                setMenu(undefined);
                void store.rescanLibraryFolder(folder.path);
              }}
            >
              Rescan folder
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            data-testid="folder-menu-remove"
            onClick={() => {
              const folder = menu.folder;
              setMenu(undefined);
              store.requestRemoveLibraryFolder(folder.path, folder.name, folder.count);
            }}
          >
            Remove folder from Library…
          </button>
        </div>
      )}
    </aside>
  );
}
