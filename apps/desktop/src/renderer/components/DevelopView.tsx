import { useAppState, useAppStore } from '../store-context';
import { activeExportPreset, activePhoto } from '../store';
import { modKeyLabel } from '../platform';
import { usePanelLayout, type ResizablePanelDefinition } from '../panel-resize';
import { ActionBar, Hints, barStyles } from './ActionBar';
import { DevelopPanel } from './DevelopPanel';
import { FilmStrip } from './FilmStrip';
import { FiltersStrip } from './FiltersStrip';
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
  const folder = preset.folderTemplate
    .replace(/^\{folder\}\//, '')
    .replace('{preset}', preset.name);
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

  return (
    <div
      ref={containerRef}
      className={styles.view}
      data-testid="develop-view"
      style={{
        gridTemplateColumns: `${metadata.width}px minmax(0, 1fr) ${develop.width}px`,
      }}
    >
      <MetadataPanel className={styles.meta} />
      <PanelResizeHandle
        panel="develop-metadata"
        label="Metadata panel"
        side="left"
        controller={metadata}
        className={styles.metaHandle}
      />
      <PhotoView className={styles.photo} photo={selected} />
      <PanelResizeHandle
        panel="develop-panel"
        label="Develop panel"
        side="right"
        controller={develop}
        className={styles.developHandle}
      />
      <DevelopPanel className={styles.develop} />
      <div className={styles.strips}>
        <FiltersStrip visibleCount={photos.length} />
        <FilmStrip photos={photos} />
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
