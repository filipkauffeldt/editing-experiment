import { useAppState, useAppStore } from '../store-context';
import { activeExportPreset, activePhoto, panelsAreHidden } from '../store';
import { isFiltering } from '../filters';
import { modKeyLabel } from '../platform';
import { usePanelLayout, type ResizablePanelDefinition } from '../panel-resize';
import { describeFolderTemplate } from '../../shared/export-folder';
import { ActionBar, Hints, barStyles } from './ActionBar';
import { DevelopPanel } from './DevelopPanel';
import { FilmStrip } from './FilmStrip';
import { FilterBar, FilterEmpty } from './FilterBar';
import { MetadataPanel } from './MetadataPanel';
import { PhotoView } from './PhotoView';
import { Button } from './ui/Button';
import { PanelResizeHandle } from './ui/PanelResizeHandle';
import styles from './DevelopView.module.css';

const PANELS = [
  { id: 'develop-metadata', side: 'left' },
  { id: 'develop-panel', side: 'right' },
] as const satisfies readonly ResizablePanelDefinition[];

/** What Next & send does: preset, size, quality, folder and where it is sent. */
function useExportSummary(): string {
  const state = useAppState();
  const preset = activeExportPreset(state);
  if (!preset) return 'No export preset';
  const size =
    preset.resize.mode === 'longEdge' || preset.resize.mode === 'shortEdge'
      ? ` ${preset.resize.pixels}`
      : preset.resize.mode === 'megapixels'
        ? ` ${preset.resize.megapixels}MP`
        : ' Full size';
  const folder = describeFolderTemplate(preset.folderTemplate, preset.name);
  const names = preset.sendTo
    .map((id) => state.destinations.find((destination) => destination.id === id)?.name)
    .filter((name): name is string => name !== undefined);
  return `${preset.name}${size} q${preset.quality} → ${folder} → ${names.length > 0 ? names.join(', ') : 'not sent'}`;
}

/** Develop and Retouch: metadata left, the photo, develop sliders right, film strip below. */
export function DevelopView() {
  const store = useAppStore();
  const state = useAppState();
  const { containerRef, panels } = usePanelLayout(PANELS);
  const metadata = panels['develop-metadata'];
  const develop = panels['develop-panel'];
  const photos = store.getVisiblePhotos();
  const selected = activePhoto(state);
  const summary = useExportSummary();
  const mod = modKeyLabel();
  // Tab, and Retouch and Crop, hide the side panels, the filter row and the film strip. They stay
  // mounted, so a panel keeps its scroll position and folded sections, and the photo gets the room.
  const hidden = panelsAreHidden(state);

  return (
    <div
      ref={containerRef}
      className={styles.view}
      data-testid="develop-view"
      style={{
        gridTemplateColumns: hidden
          ? '0px minmax(0, 1fr) 0px'
          : `${metadata.width}px minmax(0, 1fr) ${develop.width}px`,
      }}
      data-panels={hidden ? 'hidden' : 'shown'}
    >
      <div className={styles.panels} hidden={hidden} data-testid="develop-left-panels">
        <MetadataPanel className={styles.meta} />
        <PanelResizeHandle
          panel="develop-metadata"
          label="Metadata panel"
          side="left"
          controller={metadata}
          className={styles.metaHandle}
        />
      </div>
      <PhotoView className={styles.photo} photo={selected} />
      <div className={styles.panels} hidden={hidden} data-testid="develop-right-panels">
        <PanelResizeHandle
          panel="develop-panel"
          label="Develop panel"
          side="right"
          controller={develop}
          className={styles.developHandle}
        />
        <DevelopPanel className={styles.develop} />
      </div>
      <div className={styles.strips} hidden={hidden} data-testid="develop-strips">
        <FilterBar scope={state.photos} shown={photos.length} />
        {photos.length === 0 && state.photos.length > 0 && isFiltering(state.filter) ? (
          <FilterEmpty hidden={state.photos.length} />
        ) : (
          <FilmStrip photos={photos} />
        )}
      </div>
      <div className={styles.bar}>
        <ActionBar
          left={
            <>
              <span
                className={barStyles.summary}
                title="Active export preset"
                data-testid="export-summary"
              >
                {summary}
              </span>
              <Hints
                items={[
                  ['← →', 'photo'],
                  ['T', 'tag'],
                  ['1–5', 'rating'],
                  [`${mod}+1–8`, 'class'],
                  ['C', 'crop'],
                  ['R', 'retouch'],
                  ['Y', 'before/after'],
                  ['J', 'clipping'],
                ]}
              />
            </>
          }
          right={
            <>
              <Button
                data-testid="open-copy-settings"
                hint={`⇧${mod}+C`}
                onClick={() => store.openCopySettings('copy')}
              >
                Copy settings…
              </Button>
              <Button
                data-testid="open-export"
                hint={`⇧${mod}+E`}
                onClick={() => store.openExportDialog()}
              >
                Export…
              </Button>
              <Button
                variant="primary"
                data-testid="next-send"
                hint={`${mod}+Enter`}
                onClick={() => void store.nextAndSend()}
              >
                Next &amp; send
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
