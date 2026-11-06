import type { Photo } from '@ee/contracts';
import { useEffect, useMemo, type ReactNode } from 'react';
import { modKeyLabel } from '../platform';
import { sharedFields, summarizeSelection, type Shared } from '../selection-summary';
import { activePhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { KeywordsEditor } from './MetadataPanel';
import { RatingStars } from './PhotoOverlays';
import { Button } from './ui/Button';
import { TextArea } from './ui/Field';
import styles from './LibraryInspector.module.css';

/** Past this many photos the fields are not read just to compare them; the batch dialog still works. */
const COMPARE_LIMIT = 100;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={styles.rowLabel}>{label}</dt>
      <dd className={`${styles.rowValue} mono`}>{children}</dd>
    </>
  );
}

/** A shared value, or `Differs` (with the values in its tooltip). Nothing at all shows a dash. */
function SharedValue({ shared }: { shared: Shared<string> }) {
  if (shared.kind === 'differs') {
    return (
      <span className={styles.differs} title={shared.values.filter(Boolean).join(', ')}>
        Differs
      </span>
    );
  }
  return <>{shared.value || '—'}</>;
}

function FieldHeader({
  label,
  action,
  actionLabel,
  onAction,
}: {
  label: string;
  action?: string;
  actionLabel?: string;
  onAction?(): void;
}) {
  return (
    <div className={styles.fieldHeader}>
      <span className={styles.fieldLabel}>{label}</span>
      {action && (
        <Button size="small" variant="ghost" aria-label={actionLabel} onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  );
}

function SinglePhoto({ photo }: { photo: Photo }) {
  const store = useAppStore();
  const state = useAppState();
  const fields = state.metadata[photo.id] ?? {};
  const camera = photo.camera;
  const template = state.template && photo.status.metadataDiffersFromTemplate;
  return (
    <>
      <dl className={styles.table} data-testid="library-inspector-info">
        <Row label="File">{photo.fileName}</Row>
        <Row label="Size">
          {photo.width && photo.height ? `${photo.width} × ${photo.height}` : '—'}
        </Row>
        <Row label="Taken">{photo.captureTime?.replace('T', ' ') || '—'}</Row>
        <Row label="Camera">{camera?.model || '—'}</Row>
        <Row label="Lens">{camera?.lens || '—'}</Row>
        {photo.rating > 0 && (
          <Row label="Rating">
            <RatingStars rating={photo.rating} />
          </Row>
        )}
      </dl>
      {template && (
        <p className={styles.template} data-testid="library-template-state">
          Differs from the ingest template
        </p>
      )}
      <div className={styles.field}>
        <FieldHeader label="Caption" />
        <TextArea
          aria-label="Caption"
          placeholder="No caption"
          value={fields.caption ?? ''}
          onChange={(event) => store.updateMetadataField(photo.id, 'caption', event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <FieldHeader label="Keywords" />
        <KeywordsEditor
          photoId={photo.id}
          keywords={fields.keywords ?? []}
          shortcutTarget={false}
        />
      </div>
    </>
  );
}

function SeveralPhotos({ photos }: { photos: Photo[] }) {
  const store = useAppStore();
  const state = useAppState();
  const mod = modKeyLabel();
  const count = photos.length;
  const summary = useMemo(() => summarizeSelection(photos), [photos]);
  const compare = count <= COMPARE_LIMIT;
  const ids = useMemo(() => photos.map((photo) => photo.id), [photos]);
  const idsKey = ids.join('\n');

  useEffect(() => {
    if (compare) void store.ensureMetadata(ids);
    // `ids` changes identity with every photo update; the ids themselves are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, compare, idsKey]);

  const fields = compare ? sharedFields(ids, state.metadata) : undefined;
  const differing = photos.filter((photo) => photo.status.metadataDiffersFromTemplate).length;
  const caption = fields?.caption;
  const keywords = fields?.keywords;
  const pending = compare ? 'Reading…' : 'Not compared';

  return (
    <>
      <div className={styles.count} data-testid="library-inspector-count">
        {count} selected
      </div>
      <dl className={styles.table} data-testid="library-inspector-info">
        <Row label="Size">
          <SharedValue shared={summary.size} />
        </Row>
        <Row label="Taken">{summary.taken || '—'}</Row>
        <Row label="Camera">
          <SharedValue shared={summary.camera} />
        </Row>
        <Row label="Lens">
          <SharedValue shared={summary.lens} />
        </Row>
      </dl>
      {state.template && differing > 0 && (
        <p className={styles.template} data-testid="library-template-state">
          {differing} of {count} differ from the ingest template
        </p>
      )}
      <div className={styles.field} data-testid="library-inspector-caption">
        <FieldHeader
          label="Caption"
          action={`Edit… ${mod}+I`}
          actionLabel={`Edit caption of ${count} photos`}
          onAction={() => store.toggleBatchCaption(true)}
        />
        <div className={styles.readonly}>
          {!caption ? (
            <span className={styles.muted}>{pending}</span>
          ) : caption.kind === 'differs' ? (
            <span className={styles.differs}>Differs</span>
          ) : (
            caption.value || <span className={styles.muted}>No caption</span>
          )}
        </div>
      </div>
      <div className={styles.field} data-testid="library-inspector-keywords">
        <FieldHeader
          label="Keywords"
          action={`Edit… ${mod}+K`}
          actionLabel={`Edit keywords of ${count} photos`}
          onAction={() => store.toggleBatchCaption(true, 'keywords')}
        />
        <div className={styles.readonly}>
          {!keywords ? (
            <span className={styles.muted}>{pending}</span>
          ) : keywords.kind === 'differs' ? (
            <span className={styles.differs}>Differs</span>
          ) : keywords.value.length === 0 ? (
            <span className={styles.muted}>No keywords</span>
          ) : (
            <span className={styles.chips}>
              {keywords.value.map((keyword) => (
                <span key={keyword} className={styles.chip}>
                  {keyword}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Right side of the Library. One selected photo: its file facts, caption and keywords, editable.
 * Several: what they share, `Differs` where they do not, and a way into the batch caption dialog,
 * which is how several photos are edited.
 */
export function LibraryInspector({ className }: { className?: string }) {
  const state = useAppState();
  const photo = activePhoto(state);
  const selection = state.selection;
  const selected = useMemo(() => {
    if (selection.length < 2) return [];
    const ids = new Set(selection);
    return state.photos.filter((candidate) => ids.has(candidate.id));
  }, [state.photos, selection]);

  return (
    <section
      className={`${styles.panel} ${className ?? ''}`}
      aria-label="Inspector"
      data-testid="library-inspector"
    >
      {!photo ? (
        <p className={styles.empty}>Select a photo.</p>
      ) : selected.length > 1 ? (
        <SeveralPhotos photos={selected} />
      ) : (
        <SinglePhoto photo={photo} />
      )}
    </section>
  );
}
