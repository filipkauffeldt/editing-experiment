import { useMemo } from 'react';
import { selectLibraryPhotos } from '../store';
import { modKeyLabel } from '../platform';
import { usePanelLayout, type ResizablePanelDefinition } from '../panel-resize';
import { useAppState, useAppStore } from '../store-context';
import { ActionBar, barStyles } from './ActionBar';
import { LibraryGrid } from './LibraryGrid';
import { LibraryInspector } from './LibraryInspector';
import { LibraryLoupe } from './LibraryLoupe';
import { LibrarySidebar } from './LibrarySidebar';
import { LibraryToolbar } from './LibraryToolbar';
import { COLOR_CLASSES, COLOR_CLASS_NAMES } from './PhotoOverlays';
import { Button } from './ui/Button';
import { PanelResizeHandle } from './ui/PanelResizeHandle';
import styles from './LibraryView.module.css';

const PANELS = [
  { id: 'library-sidebar', side: 'left' },
  { id: 'library-inspector', side: 'right' },
] as const satisfies readonly ResizablePanelDefinition[];

/** Library: folders and collections, the contact sheet, and the inspector. */
export function LibraryView() {
  const store = useAppStore();
  const state = useAppState();
  const { containerRef, panels } = usePanelLayout(PANELS);
  const sidebar = panels['library-sidebar'];
  const inspector = panels['library-inspector'];
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
    <div
      ref={containerRef}
      className={styles.view}
      data-testid="library-view"
      style={{
        gridTemplateColumns: `${sidebar.width}px minmax(0, 1fr) ${inspector.width}px`,
      }}
    >
      <LibrarySidebar className={styles.side} />
      <PanelResizeHandle
        panel="library-sidebar"
        label="Library sidebar"
        side="left"
        controller={sidebar}
        className={styles.sideHandle}
      />
      <div className={styles.centre}>
        <LibraryToolbar count={photos.length} total={state.photos.length} />
        {library.view === 'loupe' ? (
          <LibraryLoupe photos={photos} />
        ) : (
          <LibraryGrid photos={photos} />
        )}
      </div>
      <PanelResizeHandle
        panel="library-inspector"
        label="Library inspector"
        side="right"
        controller={inspector}
        className={styles.inspectorHandle}
      />
      <LibraryInspector className={styles.inspector} />
      <div className={styles.bar}>
        <ActionBar
          testId="library-action-bar"
          left={
            <>
              <span className={barStyles.count} data-testid="library-selection-count">
                <span className="mono">{selected.length}</span> selected ·{' '}
                <span className="mono">{taggedCount}</span> tagged
              </span>
              <span className={barStyles.hints} data-testid="library-label-hints">
                Rating 1–5 · Class {mod}+1–8
              </span>
            </>
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
              <Button
                data-testid="sync-settings"
                disabled={selected.length < 2}
                onClick={() => store.openCopySettings('sync')}
              >
                Sync…
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
