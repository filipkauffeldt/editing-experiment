import type { Point } from '@ee/contracts';
import { cropCorners, cropGeometry, rotatePoint, type CropHandle } from '@ee/develop-gl';
import { useRef, useState } from 'react';
import { type CropSession } from '../store';
import { useAppStore } from '../store-context';
import styles from './PhotoCanvas.module.css';

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizedPoint = (event: React.PointerEvent, element: Element): Point => {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
    y: clamp01((event.clientY - rect.top) / Math.max(1, rect.height)),
  };
};

/** A point in the crop's local (leveled) frame, as normalized source coordinates. */
function localPoint(session: CropSession, x: number, y: number): Point {
  const geometry = cropGeometry(session.crop, session.image);
  const rotated = rotatePoint(x, y, geometry.angle);
  return {
    x: (geometry.centerX + rotated.x) / session.image.width,
    y: (geometry.centerY + rotated.y) / session.image.height,
  };
}

function handlePoint(session: CropSession, handle: CropHandle): Point {
  const geometry = cropGeometry(session.crop, session.image);
  const u = geometry.width / 2;
  const v = geometry.height / 2;
  const x = handle.includes('w') ? -u : handle.includes('e') ? u : 0;
  const y = handle.includes('n') ? -v : handle.includes('s') ? v : 0;
  return localPoint(session, x, y);
}

/**
 * Crop overlay: dims outside the crop, shows the rule-of-thirds grid and the
 * eight drag handles. The crop rectangle is shown in uncropped image space, so
 * it appears rotated while straightening.
 */
export function CropOverlay({ session }: { session: CropSession }) {
  const store = useAppStore();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragHandle = useRef<CropHandle | null>(null);
  const lineStart = useRef<Point | null>(null);
  const [line, setLine] = useState<{ from: Point; to: Point } | null>(null);

  const corners = cropCorners(session.crop, session.image).map((point) => ({
    x: point.x / session.image.width,
    y: point.y / session.image.height,
  }));
  const polygon = corners.map((point) => `${point.x},${point.y}`).join(' ');
  const geometry = cropGeometry(session.crop, session.image);
  const u = geometry.width / 2;
  const v = geometry.height / 2;
  const thirds: [Point, Point][] = [
    [localPoint(session, -u / 3, -v), localPoint(session, -u / 3, v)],
    [localPoint(session, u / 3, -v), localPoint(session, u / 3, v)],
    [localPoint(session, -u, -v / 3), localPoint(session, u, -v / 3)],
    [localPoint(session, -u, v / 3), localPoint(session, u, v / 3)],
  ];

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-crop-handle]')?.dataset.cropHandle as
      CropHandle | undefined;
    event.preventDefault();
    overlay.setPointerCapture(event.pointerId);
    if (session.tool === 'straighten') {
      const point = normalizedPoint(event, overlay);
      lineStart.current = point;
      setLine({ from: point, to: point });
      return;
    }
    if (handle) dragHandle.current = handle;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const point = normalizedPoint(event, overlay);
    if (dragHandle.current) {
      store.dragCropHandle(dragHandle.current, point);
      return;
    }
    if (lineStart.current) setLine({ from: lineStart.current, to: point });
  };

  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (overlay.hasPointerCapture(event.pointerId)) {
      overlay.releasePointerCapture(event.pointerId);
    }
    dragHandle.current = null;
    const start = lineStart.current;
    lineStart.current = null;
    if (start && line) {
      const end = normalizedPoint(event, overlay);
      const dx = (end.x - start.x) * session.image.width;
      const dy = (end.y - start.y) * session.image.height;
      if (Math.hypot(dx, dy) > 8) {
        let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        while (angle > 90) angle -= 180;
        while (angle < -90) angle += 180;
        store.setCropAngle(angle);
        store.setCropTool('crop');
      }
    }
    setLine(null);
  };

  return (
    <div
      ref={overlayRef}
      className={`${styles.cropOverlay} ${session.tool === 'straighten' ? styles.straighten : ''}`}
      data-testid="crop-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <svg className={styles.cropSvg} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
        <defs>
          <mask id="crop-dim-mask">
            <rect x="0" y="0" width="1" height="1" fill="white" />
            <polygon points={polygon} fill="black" />
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="1"
          height="1"
          className={styles.cropDim}
          mask="url(#crop-dim-mask)"
        />
        <polygon points={polygon} className={styles.cropBorder} />
        {thirds.map(([from, to], index) => (
          <line
            key={index}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            className={styles.cropThirds}
          />
        ))}
        {line && (
          <line
            x1={line.from.x}
            y1={line.from.y}
            x2={line.to.x}
            y2={line.to.y}
            className={styles.straightenLine}
          />
        )}
      </svg>
      {HANDLES.map((handle) => {
        const point = handlePoint(session, handle);
        return (
          <div
            key={handle}
            className={`${styles.cropHandle} ${styles[`handle_${handle}`] ?? ''}`}
            data-crop-handle={handle}
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          />
        );
      })}
    </div>
  );
}
