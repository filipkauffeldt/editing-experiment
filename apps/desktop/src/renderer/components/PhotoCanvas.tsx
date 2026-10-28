import { appUrl, type Photo } from '@ee/contracts';
import styles from './PhotoCanvas.module.css';

/**
 * Mount point for the develop renderer.
 *
 * TODO(develop-gl): replace the placeholder `<img>` below with the WebGL2
 * canvas from `@ee/develop-gl`. Keep the surrounding sizing contract: the
 * canvas must fit the available centre area and report its rendered size so
 * retouch selections can be mapped back to normalized image coordinates. The
 * preview URL is already available as `appUrl.preview(photo.id)`; once the
 * pipeline lands it should read `appUrl.linear(photo.id, maxEdge)` instead.
 */
export function PhotoCanvas({ photo }: { photo: Photo | undefined }) {
  if (!photo) {
    return (
      <div className={styles.empty} data-testid="photo-canvas">
        No photos yet. Start an ingest to fill the film strip.
      </div>
    );
  }
  return (
    <div className={styles.canvasWrap} data-testid="photo-canvas">
      <img
        className={styles.image}
        src={appUrl.preview(photo.id)}
        alt={photo.fileName}
        draggable={false}
      />
    </div>
  );
}
