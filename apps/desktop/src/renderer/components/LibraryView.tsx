import { useMemo } from 'react';
import { panelsAreHidden, selectLibraryPhotos, selectLibraryScope } from '../store';
import { isFiltering } from '../filters';
import { THUMB_SIZE_RANGE } from '../library';
import { modKeyLabel } from '../platform';
import { usePanelLayout, type ResizablePanelDefinition } from '../panel-resize';
import { useAppState, useAppStore } from '../store-context';
import { ActionBar, barStyles } from './ActionBar';
import { LibraryGrid } from './LibraryGrid';
import { LibraryInspector } from './LibraryInspector';
import { LibraryLoupe } from './LibraryLoupe';
import { LibrarySidebar } from './LibrarySidebar';
import { FilterBar, FilterEmpty } from './FilterBar';
import { Button } from './ui/Button';
import { Slider } from './ui/Slider';
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
    [state.photos, state.library.folder, state.filter, state.searchResult, state.sort],
  );
  const scope = useMemo(
    () => selectLibraryScope(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.photos, state.library.folder],
  );
  const hiddenByFilter = photos.length === 0 && scope.length > 0 && isFiltering(state.filter);
  const selected = state.selection;
  const mod = modKeyLabel();
  const none = selected.length === 0;
  // Tab hides the sidebar and the inspector. They stay mounted, so they keep their scroll position.
  const hidden = panelsAreHidden(state);

  return (
    <div
      ref={containerRef}
      className={styles.view}
      data-testid="library-view"
      style={{
        gridTemplateColumns: hidden
          ? '0px minmax(0, 1fr) 0px'
          : `${sidebar.width}px minmax(0, 1fr) ${inspector.width}px`,
      }}
      data-panels={hidden ? 'hidden' : 'shown'}
    >
      <div className={styles.panels} hidden={hidden} data-testid="library-left-panels">
        <LibrarySidebar className={styles.side} />
        <PanelResizeHandle
          panel="library-sidebar"
          label="Library sidebar"
          side="left"
          controller={sidebar}
          className={styles.sideHandle}
        />
      </div>
      <div className={styles.centre}>
        <FilterBar scope={scope} shown={photos.length}>
          <div className={styles.size}>
            <Slider
              label="Size"
              value={library.thumbSize}
              min={THUMB_SIZE_RANGE.min}
              max={THUMB_SIZE_RANGE.max}
              step={4}
              neutral={THUMB_SIZE_RANGE.min}
              display={library.thumbSize}
              onRange={(value) => store.setThumbSize(value)}
              onNumber={(value) => store.setThumbSize(value ?? THUMB_SIZE_RANGE.default)}
              onReset={() => store.setThumbSize(THUMB_SIZE_RANGE.default)}
            />
          </div>
        </FilterBar>
        {hiddenByFilter ? (
          <FilterEmpty hidden={scope.length} />
        ) : library.view === 'loupe' ? (
          <LibraryLoupe photos={photos} />
        ) : (
          <LibraryGrid photos={photos} />
        )}
      </div>
      <div className={styles.panels} hidden={hidden} data-testid="library-right-panels">
        <PanelResizeHandle
          panel="library-inspector"
          label="Library inspector"
          side="right"
          controller={inspector}
          className={styles.inspectorHandle}
        />
        <LibraryInspector className={styles.inspector} />
      </div>
      <div className={styles.bar}>
        <ActionBar
          testId="library-action-bar"
          left={
            <span className={barStyles.count} data-testid="library-selection-count">
              <span className="mono">{selected.length}</span> selected
            </span>
          }
          right={
            <>
              <Button
                disabled={none}
                title={`Caption (${mod}+I)`}
                onClick={() => store.toggleBatchCaption(true)}
              >
                Caption…
              </Button>
              <Button
                data-testid="sync-settings"
                disabled={selected.length < 2}
                onClick={() => store.openCopySettings('sync')}
              >
                Sync settings…
              </Button>
              <Button
                disabled={none}
                title={`Export (⇧${mod}+E)`}
                onClick={() => store.openExportDialog()}
              >
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
