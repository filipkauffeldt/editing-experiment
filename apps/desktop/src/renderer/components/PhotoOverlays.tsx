import type { Photo, UploadItem } from '@ee/contracts';
import { Dot } from './ui/Dot';
import styles from './PhotoOverlays.module.css';

/** Colour class dots, index 0 is "none". The only colour on a thumbnail besides the photo. */
export const COLOR_CLASSES = [
  '',
  'var(--class-1)',
  'var(--class-2)',
  'var(--class-3)',
  'var(--class-4)',
  'var(--class-5)',
  'var(--class-6)',
  'var(--class-7)',
  'var(--class-8)',
] as const;

export const COLOR_CLASS_NAMES = [
  'None',
  'Winner',
  'Winner alt',
  'Superior',
  'Superior alt',
  'Typical',
  'Typical alt',
  'Extras',
  'Trash',
] as const;

export function ColorDot({ colorClass }: { colorClass: number }) {
  const color = COLOR_CLASSES[colorClass] ?? '';
  if (!color) return null;
  return (
    <Dot color={color} size={7} title={`Class ${colorClass} · ${COLOR_CLASS_NAMES[colorClass]}`} />
  );
}

/** Filled stars in the muted text colour; nothing for an unrated photo. */
export function RatingStars({ rating }: { rating: number }) {
  const value = Math.min(5, Math.max(0, Math.trunc(rating)));
  if (value === 0) return null;
  return (
    <span
      className={styles.stars}
      role="img"
      aria-label={`Rating ${value} of 5`}
      title={`Rating ${value} of 5`}
      data-testid="rating-stars"
    >
      {'★'.repeat(value)}
    </span>
  );
}

/** The 11 px tag square. Pass `onToggle` to make it a button. */
export function TagSquare({ tagged, onToggle }: { tagged: boolean; onToggle?(): void }) {
  const className = `${styles.tag} ${tagged ? styles.tagged : ''}`;
  if (!onToggle) return <span className={className} title={tagged ? 'Tagged' : undefined} />;
  return (
    <button
      type="button"
      className={className}
      aria-pressed={tagged}
      aria-label={tagged ? 'Untag' : 'Tag'}
      title={tagged ? 'Tagged' : 'Tag (T)'}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    />
  );
}

/** Upload progress per photo, taken from the newest unfinished item, as a rounded percentage. */
export function uploadPercent(items: readonly UploadItem[] | undefined): number | undefined {
  const active = items?.find((item) => item.state === 'uploading');
  if (!active || active.bytesTotal <= 0) return undefined;
  return Math.min(100, Math.round((active.bytesSent / active.bytesTotal) * 100));
}

/** Group uploads by photo once per render, not once per cell. */
export function uploadsByPhoto(uploads: readonly UploadItem[]): Map<string, UploadItem[]> {
  const map = new Map<string, UploadItem[]>();
  for (const item of uploads) {
    const list = map.get(item.photoId);
    if (list) list.push(item);
    else map.set(item.photoId, [item]);
  }
  return map;
}

/** Status text labels for a thumbnail. Titles are what the tests and screen readers read. */
export function StatusLabels({ photo, percent }: { photo: Photo; percent?: number }) {
  const retouch = photo.versions.some((version) => version.kind === 'retouch');
  const upload = photo.status.upload;
  return (
    <span className={styles.labels}>
      {retouch ? (
        <span className={`${styles.label} ${styles.labelDim}`} title="Retouch version">
          retouched
        </span>
      ) : (
        photo.status.edited && (
          <span className={`${styles.label} ${styles.labelDim}`} title="Edited">
            edited
          </span>
        )
      )}
      {photo.status.metadataDiffersFromTemplate && (
        <span
          className={`${styles.label} ${styles.labelDim}`}
          title="Metadata differs from template"
        >
          meta ≠
        </span>
      )}
      {upload === 'done' && (
        <span className={styles.label} title="Uploaded">
          sent
        </span>
      )}
      {upload === 'uploading' && (
        <span className={styles.label} title="Uploading">
          {percent === undefined ? 'sending' : `sending ${percent}%`}
        </span>
      )}
      {upload === 'queued' && (
        <span className={`${styles.label} ${styles.labelDim}`} title="Queued for upload">
          queued
        </span>
      )}
      {upload === 'failed' && (
        <span className={`${styles.label} ${styles.labelFailed}`} title="Upload failed">
          failed
        </span>
      )}
    </span>
  );
}
