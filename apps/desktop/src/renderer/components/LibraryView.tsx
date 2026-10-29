import { useMemo } from 'react';
import { selectLibraryPhotos } from '../store';
import { modKeyLabel } from '../platform';
import { useAppState, useAppStore } from '../store-context';
import { ActionBar, barStyles } from './ActionBar';
import { LibraryGrid } from './LibraryGrid';
import { LibraryInspector } from './LibraryInspector';
import { LibraryLoupe } from './LibraryLoupe';
import { LibrarySidebar } from './LibrarySidebar';
import { LibraryToolbar } from './LibraryToolbar';
import { COLOR_CLASSES, COLOR_CLASS_NAMES } from './PhotoOverlays';
import { Button } from './ui/Button';
import styles from './LibraryView.module.css';

/** Library: folders and collections, the contact sheet, and the inspector. */
export function LibraryView() {
  const store = useAppStore();
  const state = useAppState();
  const { library } = state;
  // The grid follows every photo event; sorting is only redone when something it shows changes.
  const photos = useMemo(
    () => selectLibraryPhotos(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.photos,
      state.library.folder,
      state.library.collection,
      state.library.quick,
      state.library.colorClass,
      state.sort,
    ],
  );
  const selected = state.selection;
  const taggedCount = useMemo(() => {
    const ids = new Set(selected);
    return state.photos.filter((photo) => ids.has(photo.id) && photo.tagged).length;
  }, [state.photos, selected]);
  const mod = modKeyLabel();
  const none = selected.length === 0;

  return (
    <div className={styles.view} data-testid="library-view">
      <LibrarySidebar className={styles.side} />
      <div className={styles.centre}>
        <LibraryToolbar count={photos.length} total={state.photos.length} />
        {library.view === 'loupe' ? (
          <LibraryLoupe photos={photos} />
        ) : (
          <LibraryGrid photos={photos} />
        )}
      </div>
      <LibraryInspector className={styles.inspector} />
      <div className={styles.bar}>
        <ActionBar
          testId="library-action-bar"
          left={
            <span className={barStyles.count} data-testid="library-selection-count">
              <span className="mono">{selected.length}</span> selected ·{' '}
              <span className="mono">{taggedCount}</span> tagged
            </span>
          }
          right={
            <>
              <Button disabled={none} hint="T" onClick={() => store.toggleTag()}>
                Tag
              </Button>
              <span className={styles.classes} role="group" aria-label="Class">
                <span className={styles.classLabel}>Class</span>
                {COLOR_CLASSES.slice(1).map((color, index) => (
                  <button
                    key={color}
                    type="button"
                    className={styles.classButton}
                    disabled={none}
                    title={`Class ${index + 1} · ${COLOR_CLASS_NAMES[index + 1]}`}
                    aria-label={`Set class ${index + 1}`}
                    onClick={() => store.setColorClass(index + 1)}
                  >
                    <span className={styles.classDot} style={{ background: color }} />
                    <span className="mono">{index + 1}</span>
                  </button>
                ))}
              </span>
              <span className={barStyles.separator} />
              <Button
                disabled={none}
                hint={`${mod}+I`}
                onClick={() => store.toggleBatchCaption(true)}
              >
                Caption…
              </Button>
              <Button disabled={none} hint={`⇧${mod}+E`} onClick={() => store.openExportDialog()}>
                Export…
              </Button>
              <Button
                variant="primary"
                disabled={none}
                hint={`⇧${mod}+Enter`}
                onClick={() => void store.exportSelected(true)}
              >
                Export &amp; send
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
