import type { Point } from '@ee/contracts';
import { cropGeometry, type CropHandle } from '@ee/develop-gl';
import { useRef, useState } from 'react';
import {
  cropLayout,
  cursorFor,
  frameRect,
  guideSegments,
  hitTestFrame,
  screenToView,
  viewToScreen,
  type FrameHit,
  type Size,
} from '../crop-view';
import { type CropSession } from '../store';
import { useAppStore } from '../store-context';
import styles from './PhotoCanvas.module.css';

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Crop overlay, Lightroom style. The frame is axis-aligned on screen and the
 * image turns underneath it (the canvas draws that); this layer draws the frame
 * and guides and turns pointer input into store gestures:
 *
 * - a corner or edge resizes, with the opposite side anchored;
 * - inside the frame pans the image;
 * - outside the frame rotates it about the frame centre;
 * - the crop frame tool (`draw`) drags out a new frame instead;
 * - the straighten tool draws a line along the horizon.
 *
 * Pointer positions are CSS pixels in the stage; the store takes view
 * coordinates, so everything goes through the layout.
 */
export function CropOverlay({ session, stage }: { session: CropSession; stage: Size }) {
  const store = useAppStore();
  const overlayRef = useRef<HTMLDivElement>(null);
  const active = useRef<'gesture' | 'line' | null>(null);
  const lineFrom = useRef<Point | null>(null);
  const [hover, setHover] = useState<FrameHit>();
  // What the press that started the current drag landed on; keeps the cursor fixed while dragging.
  const [grabbed, setGrabbed] = useState<FrameHit>();
  const [line, setLine] = useState<{ from: Point; to: Point } | null>(null);

  const layout = cropLayout(stage, session.image);
  const geometry = cropGeometry(session.crop, session.image);
  const rect = frameRect(layout, session.pivot, geometry.width, geometry.height);

  const localPoint = (event: React.PointerEvent | React.MouseEvent): Point => {
    const box = overlayRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    event.preventDefault();
    overlay.setPointerCapture(event.pointerId);
    const screen = localPoint(event);
    const view = screenToView(layout, screen);
    if (session.tool === 'straighten') {
      active.current = 'line';
      lineFrom.current = view;
      setLine({ from: view, to: view });
      return;
    }
    active.current = 'gesture';
    if (session.tool === 'draw') {
      store.beginCropGesture({ kind: 'draw' }, view);
      return;
    }
    const hit = hitTestFrame(rect, screen);
    setGrabbed(hit);
    store.beginCropGesture(
      hit === 'move'
        ? { kind: 'pan' }
        : hit === 'rotate'
          ? { kind: 'rotate' }
          : { kind: 'resize', handle: hit },
      view,
    );
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const screen = localPoint(event);
    if (active.current === 'gesture') {
      store.updateCropGesture(screenToView(layout, screen), {
        shift: event.shiftKey,
        alt: event.altKey,
      });
    } else if (active.current === 'line') {
      const from = lineFrom.current;
      if (from) setLine({ from, to: screenToView(layout, screen) });
    } else {
      setHover(session.tool === 'crop' ? hitTestFrame(rect, screen) : undefined);
    }
  };

  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    const overlay = overlayRef.current;
    if (overlay?.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    const kind = active.current;
    active.current = null;
    setGrabbed(undefined);
    if (kind === 'gesture') store.endCropGesture();
    if (kind === 'line') {
      const from = lineFrom.current;
      lineFrom.current = null;
      if (from) store.straightenAlongLine(from, screenToView(layout, localPoint(event)));
      setLine(null);
    }
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (session.tool === 'crop' && hitTestFrame(rect, localPoint(event)) === 'move') {
      store.applyCrop();
    }
  };

  const hit = grabbed ?? hover ?? 'rotate';
  const cursor = session.tool === 'crop' ? cursorFor(hit, session.gesture === 'pan') : 'crosshair';
  const rotating = session.gesture === 'rotate';
  // Lightroom's "auto" overlay: shown while interacting or hovering over the frame.
  const showGuides = session.gesture !== undefined || (hover !== undefined && hover !== 'rotate');
  const guides = showGuides ? guideSegments(session.overlay, rect, rotating) : [];

  const handlePoint = (handle: CropHandle): Point => ({
    x: handle.includes('w')
      ? rect.left
      : handle.includes('e')
        ? rect.right
        : (rect.left + rect.right) / 2,
    y: handle.includes('n')
      ? rect.top
      : handle.includes('s')
        ? rect.bottom
        : (rect.top + rect.bottom) / 2,
  });
  const lineFromScreen = line ? viewToScreen(layout, line.from) : undefined;
  const lineToScreen = line ? viewToScreen(layout, line.to) : undefined;

  return (
    <div
      ref={overlayRef}
      className={`${styles.cropOverlay} ${cursor === 'rotate' ? styles.cursorRotate : ''}`}
      style={cursor === 'rotate' ? undefined : { cursor }}
      data-testid="crop-overlay"
      data-tool={session.tool}
      data-gesture={session.gesture ?? ''}
      data-guide={session.overlay}
      data-guides={guides.length}
      data-angle={session.crop.angle}
      data-frame={`${rect.left},${rect.top},${rect.right - rect.left},${rect.bottom - rect.top}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={() => setHover(undefined)}
      onDoubleClick={onDoubleClick}
    >
      <svg
        className={styles.cropSvg}
        width={stage.width}
        height={stage.height}
        viewBox={`0 0 ${stage.width} ${stage.height}`}
        aria-hidden
      >
        <rect
          x={rect.left}
          y={rect.top}
          width={rect.right - rect.left}
          height={rect.bottom - rect.top}
          className={styles.cropBorder}
        />
        {guides.map((segment, index) => (
          <line
            key={index}
            x1={segment.x1}
            y1={segment.y1}
            x2={segment.x2}
            y2={segment.y2}
            className={rotating ? styles.cropFineGrid : styles.cropThirds}
          />
        ))}
        {lineFromScreen && lineToScreen && (
          <line
            x1={lineFromScreen.x}
            y1={lineFromScreen.y}
            x2={lineToScreen.x}
            y2={lineToScreen.y}
            className={styles.straightenLine}
          />
        )}
      </svg>
      {HANDLES.map((handle) => {
        const point = handlePoint(handle);
        return (
          <div
            key={handle}
            className={styles.cropHandle}
            data-crop-handle={handle}
            style={{ left: `${point.x}px`, top: `${point.y}px` }}
          />
        );
      })}
    </div>
  );
}
