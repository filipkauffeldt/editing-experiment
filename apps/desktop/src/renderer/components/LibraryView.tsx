import { useMemo } from 'react';
import { panelsAreHidden, selectLibraryPhotos, selectLibraryScope } from '../store';
import { isFiltering } from '../filters';
import { THUMB_SIZE_RANGE } from '../library';
import { COMPARE_HINT, COMPARE_ZOOM_KEY, canCompare } from '../compare-view';
import { LOUPE_ZOOM_KEY } from '../loupe-view';
import { modKeyLabel } from '../platform';
import { usePanelLayout, type ResizablePanelDefinition } from '../panel-resize';
import { useAppState, useAppStore } from '../store-context';
import { ActionBar, barStyles } from './ActionBar';
import { LibraryGrid } from './LibraryGrid';
import { LibraryInspector } from './LibraryInspector';
import { AutoAdvanceToggle } from './AutoAdvanceToggle';
import { CompareView } from './CompareView';
import { LibraryLoupe } from './LibraryLoupe';
import { ZoomLevels } from './ZoomLevels';
import { LibrarySidebar } from './LibrarySidebar';
import { FilterBar, FilterEmpty } from './FilterBar';
import { Button } from './ui/Button';
import { Slider } from './ui/Slider';
import { PanelResizeHandle } from './ui/PanelResizeHandle';
import styles from './LibraryView.module.css';

const PANELS = [
  { id: 'library-inspector', side: 'left' },
  { id: 'library-sidebar', side: 'right' },
] as const satisfies readonly ResizablePanelDefinition[];

/** Library: the inspector, the contact sheet, and folders, with metadata where Develop has it. */
export function LibraryView() {
  const store = useAppStore();
  const state = useAppState();
  const { containerRef, panels } = usePanelLayout(PANELS);
  const inspector = panels['library-inspector'];
  const sidebar = panels['library-sidebar'];
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
  const scopeTotal = state.lazy ? (state.facets?.scopeTotal ?? scope.length) : scope.length;
  const hiddenByFilter = photos.length === 0 && scopeTotal > 0 && isFiltering(state.filter);
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
          : `${inspector.size}px minmax(0, 1fr) ${sidebar.size}px`,
      }}
      data-panels={hidden ? 'hidden' : 'shown'}
    >
      <div className={styles.panels} hidden={hidden} data-testid="library-left-panels">
        <LibraryInspector className={styles.inspector} />
        <PanelResizeHandle
          panel="library-inspector"
          label="Library inspector"
          side="left"
          controller={inspector}
          className={styles.inspectorHandle}
        />
      </div>
      <div className={styles.centre}>
        <FilterBar scope={scope} shown={photos.length}>
          {library.view === 'compare' ? (
            <>
              <Button size="small" variant="ghost" hint="Esc" onClick={store.closeCompare}>
                Back to grid
              </Button>
              <ZoomLevels viewKey={COMPARE_ZOOM_KEY} />
            </>
          ) : library.view === 'loupe' ? (
            <>
              <AutoAdvanceToggle />
              <ZoomLevels viewKey={LOUPE_ZOOM_KEY} />
            </>
          ) : (
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
          )}
        </FilterBar>
        {hiddenByFilter ? (
          <FilterEmpty hidden={scopeTotal} />
        ) : library.view === 'compare' ? (
          <CompareView />
        ) : library.view === 'loupe' ? (
          <LibraryLoupe photos={photos} />
        ) : (
          <LibraryGrid photos={photos} />
        )}
      </div>
      <div className={styles.panels} hidden={hidden} data-testid="library-right-panels">
        <PanelResizeHandle
          panel="library-sidebar"
          label="Library sidebar"
          side="right"
          controller={sidebar}
          className={styles.sideHandle}
        />
        <LibrarySidebar className={styles.side} />
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
                data-testid="compare-button"
                disabled={!canCompare(selected.length)}
                title={
                  canCompare(selected.length) ? 'Compare the selected photos (V)' : COMPARE_HINT
                }
                active={library.view === 'compare'}
                onClick={() =>
                  library.view === 'compare' ? store.closeCompare() : store.openCompare()
                }
              >
                Compare
              </Button>
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
