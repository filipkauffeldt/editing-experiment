import { appUrl } from '@ee/contracts';
import { activePhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { COLOR_CLASS_NAMES, RatingStars } from './PhotoOverlays';
import { Panel } from './Panel';
import { PanelSection } from './ui/PanelSection';
import { TextArea } from './ui/Field';
import styles from './LibraryInspector.module.css';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={`${styles.rowValue} mono`}>{value || '—'}</span>
    </div>
  );
}

/** Right side of the Library: preview, key EXIF, template state and caption of the open photo. */
export function LibraryInspector({ className }: { className?: string }) {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const selected = state.selection.length;
  const fields = photo ? (state.metadata[photo.id] ?? {}) : {};
  const camera = photo?.camera;

  return (
    <Panel
      title={selected > 1 ? `Inspector · ${selected} selected` : 'Inspector'}
      className={className}
      testId="library-inspector"
    >
      {!photo ? (
        <p className={styles.empty}>Select a photo.</p>
      ) : (
        <>
          <PanelSection title="Preview" flush>
            <div className={styles.preview}>
              <img
                src={appUrl.preview(photo.id, photo.previewRevision)}
                alt={photo.fileName}
                draggable={false}
              />
            </div>
          </PanelSection>

          <PanelSection title="Info">
            <Row label="File" value={photo.fileName} />
            <Row
              label="Size"
              value={photo.width && photo.height ? `${photo.width} × ${photo.height}` : ''}
            />
            <Row label="Taken" value={photo.captureTime?.replace('T', ' ') ?? ''} />
            <Row label="Camera" value={camera?.model ?? ''} />
            <Row label="Lens" value={camera?.lens ?? ''} />
            <Row
              label="Class"
              value={
                photo.colorClass
                  ? `${photo.colorClass} · ${COLOR_CLASS_NAMES[photo.colorClass]}`
                  : ''
              }
            />
            <Row label="Tagged" value={photo.tagged ? 'yes' : 'no'} />
            {photo.rating > 0 && (
              <div className={styles.row}>
                <span className={styles.rowLabel}>Rating</span>
                <RatingStars rating={photo.rating} />
              </div>
            )}
          </PanelSection>

          <PanelSection title="Template">
            <p className={styles.template} data-testid="library-template-state">
              {!state.template
                ? 'No ingest template'
                : photo.status.metadataDiffersFromTemplate
                  ? 'Metadata differs from the ingest template'
                  : 'Matches the ingest template'}
            </p>
          </PanelSection>

          <PanelSection title="Caption">
            <TextArea
              aria-label="Caption"
              placeholder="No caption"
              value={fields.caption ?? ''}
              onChange={(event) =>
                store.updateMetadataField(photo.id, 'caption', event.target.value)
              }
            />
          </PanelSection>
        </>
      )}
    </Panel>
  );
}
