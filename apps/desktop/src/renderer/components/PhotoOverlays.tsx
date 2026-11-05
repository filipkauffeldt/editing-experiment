import type { ReactNode } from 'react';
import type { ExportJob, ExportPhotoProgress, Photo, UploadItem } from '@ee/contracts';
import {
  ClockIcon,
  ExportIcon,
  MosaicIcon,
  NotEqualIcon,
  SentIcon,
  SlidersIcon,
  UploadIcon,
  WarningIcon,
} from './icons';
import { Dot } from './ui/Dot';
import styles from './PhotoOverlays.module.css';

const ICON_SIZE = 10;

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
    <Dot
      color={color}
      size={7}
      title={`Colour label ${colorClass} · ${COLOR_CLASS_NAMES[colorClass]}`}
    />
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

/** What a photo's newest export job says about its badge. */
export type PhotoExportBadge = 'exporting' | 'exported' | 'failed';

function exportBadgeFor(state: ExportPhotoProgress['state']): PhotoExportBadge {
  switch (state) {
    case 'queued':
    case 'rendering':
    case 'exporting':
      return 'exporting';
    case 'sending':
    case 'done':
    case 'skipped':
      return 'exported';
    case 'failed':
    case 'cancelled':
      return 'failed';
  }
}

/**
 * The newest job that mentions each photo. Jobs arrive newest first, so a failed
 * retry hides an older Exported instead of leaving it on screen. Grouped once
 * per render, like {@link uploadsByPhoto}.
 */
export function exportBadgesByPhoto(jobs: readonly ExportJob[]): Map<string, PhotoExportBadge> {
  const map = new Map<string, PhotoExportBadge>();
  for (const job of jobs) {
    for (const progress of job.photos) {
      if (!map.has(progress.photoId)) map.set(progress.photoId, exportBadgeFor(progress.state));
    }
  }
  return map;
}

function exportBadge(
  photo: Photo,
  jobState: PhotoExportBadge | undefined,
): PhotoExportBadge | undefined {
  if (jobState === 'failed') return undefined;
  if (jobState !== undefined) return jobState;
  if (photo.status.export === 'done') return 'exported';
  if (photo.status.export === 'rendering' || photo.status.export === 'encoding') return 'exporting';
  return undefined;
}

/** One status glyph of the row. The title is the tooltip, the label is what tests and screen readers read. */
function StatusIcon({
  label,
  title = label,
  status,
  children,
}: {
  label: string;
  title?: string;
  status?: 'failed' | 'busy';
  children: ReactNode;
}) {
  const classes = [styles.badge, status === 'failed' ? styles.failed : ''];
  return (
    <span
      className={classes.filter(Boolean).join(' ')}
      role="img"
      aria-label={label}
      title={title}
      data-status={status}
    >
      {children}
    </span>
  );
}

/**
 * A thumbnail's status as one row of small monochrome icons, bottom-left: edited or retouched,
 * the export step, the upload step, and metadata that differs from the template. At most four
 * can show at once, so the row stays inside the thumbnail at the smallest size.
 */
export function StatusIcons({
  photo,
  percent,
  exportState,
}: {
  photo: Photo;
  percent?: number;
  exportState?: PhotoExportBadge;
}) {
  const retouch = photo.versions.some((version) => version.kind === 'retouch');
  const upload = photo.status.upload;
  const exporting = exportBadge(photo, exportState);
  return (
    <span className={styles.icons} data-testid="status-icons">
      {retouch ? (
        <StatusIcon label="Retouched" title="Retouched">
          <MosaicIcon size={ICON_SIZE} />
        </StatusIcon>
      ) : (
        photo.status.edited && (
          <StatusIcon label="Edited">
            <SlidersIcon size={ICON_SIZE} />
          </StatusIcon>
        )
      )}
      {exporting === 'exporting' && (
        <StatusIcon label="Exporting">
          <span className={styles.spinner} aria-hidden="true" />
        </StatusIcon>
      )}
      {exporting === 'exported' && (
        <StatusIcon label="Exported">
          <ExportIcon size={ICON_SIZE} />
        </StatusIcon>
      )}
      {upload === 'queued' && (
        <StatusIcon label="Queued">
          <ClockIcon size={ICON_SIZE} />
        </StatusIcon>
      )}
      {upload === 'uploading' && (
        <StatusIcon label={percent === undefined ? 'Sending' : `Sending ${percent}%`} status="busy">
          <UploadIcon size={ICON_SIZE} className={styles.uploadingIcon} />
          {percent !== undefined && (
            <span className={styles.progress} style={{ width: `${percent}%` }} aria-hidden="true" />
          )}
        </StatusIcon>
      )}
      {upload === 'done' && (
        <StatusIcon label="Sent">
          <SentIcon size={ICON_SIZE} />
        </StatusIcon>
      )}
      {upload === 'failed' && (
        <StatusIcon label="Failed" status="failed">
          <WarningIcon size={ICON_SIZE} />
        </StatusIcon>
      )}
      {photo.status.metadataDiffersFromTemplate && (
        <StatusIcon label="Differs from template">
          <NotEqualIcon size={ICON_SIZE} />
        </StatusIcon>
      )}
    </span>
  );
}
