import type { PhotoId, Point } from '@ee/contracts';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Size } from './crop-view';
import { createStore } from './develop-view';
import {
  DEFAULT_ZOOM_LEVEL,
  FIT_VIEW,
  ZOOM_STEP,
  levelScale,
  overPicture,
  panBy,
  reclamp,
  viewLayout,
  wheelZoomFactor,
  zoomBy,
  zoomTo,
  type ViewLayout,
  type ZoomContext,
  type ZoomView,
} from './view-transform';

/**
 * The zoom and pan of the main photo view. Like the other view-only develop state it is not in
 * `AppState` and never reaches a sidecar: a zoom redraws the canvas, it does not edit the photo.
 */

export type ZoomMode = 'develop' | 'crop' | 'retouch';

/** A view belongs to one photo in one mode; anything else starts at Fit. */
export const zoomKey = (photoId: PhotoId, mode: ZoomMode): string => `${photoId}|${mode}`;

export interface ZoomState {
  /** What `view` belongs to ({@link zoomKey}); another photo or mode shows Fit. */
  key: string | undefined;
  view: ZoomView;
  /** The level `Z` zooms to, in device pixels per picture pixel. */
  level: number;
  /** Space is held: a drag pans the view, and the active tool is suppressed. */
  panHeld: boolean;
}

export const zoomStore = createStore<ZoomState>({
  key: undefined,
  view: FIT_VIEW,
  level: DEFAULT_ZOOM_LEVEL,
  panHeld: false,
});

const viewFor = (state: ZoomState, key: string): ZoomView =>
  state.key === key ? state.view : FIT_VIEW;

const setView = (key: string, view: ZoomView): void => {
  zoomStore.update((state) => ({ ...state, key, view }));
};

const clearView = (key: string): void => {
  zoomStore.update((state) =>
    state.key === key ? { ...state, key: undefined, view: FIT_VIEW } : state,
  );
};

export function useZoomState(): ZoomState {
  return useSyncExternalStore(zoomStore.subscribe, zoomStore.get, zoomStore.get);
}

export const setPanHeld = (panHeld: boolean): void => {
  if (zoomStore.get().panHeld === panHeld) return;
  zoomStore.update((state) => ({ ...state, panHeld }));
};

/** What the keyboard and the footer ask the photo canvas for; it alone knows the geometry. */
export interface ZoomController {
  toggle(): void;
  step(direction: 1 | -1): void;
  /** `'fit'`, or a level to zoom to and make the level `Z` goes to. */
  setLevel(level: number | 'fit'): void;
}

let controller: ZoomController | undefined;

export const zoomCommands: ZoomController = {
  toggle: () => controller?.toggle(),
  step: (direction) => controller?.step(direction),
  setLevel: (level) => controller?.setLevel(level),
};

const registerController = (next: ZoomController): (() => void) => {
  controller = next;
  return () => {
    if (controller === next) controller = undefined;
  };
};

/**
 * What the zoom maths needs of the canvas: where Fit puts the picture (CSS pixels of the canvas
 * container), the picture being shown in its own pixels (the full-resolution crop output, or the
 * whole image), the container, and the device pixel ratio.
 */
export type ZoomGeometry = ZoomContext;

export interface ZoomControls {
  view: ZoomView;
  /** Where the picture sits now, in CSS pixels of the container. */
  layout: ViewLayout;
  /** Whether a Space-drag is in progress. */
  dragging: boolean;
  panHandlers: {
    onPointerDown(event: React.PointerEvent): void;
    onPointerMove(event: React.PointerEvent): void;
    onPointerUp(event: React.PointerEvent): void;
    onPointerCancel(event: React.PointerEvent): void;
  };
}

/**
 * Zoom state for the canvas of one photo and mode: the view and layout to draw with, the Ctrl/Cmd
 * wheel and pinch, the pointer position `Z` zooms about, the Space-drag pan, and the commands the
 * keyboard and the footer send.
 */
export function useZoomControls(
  key: string,
  geometry: ZoomGeometry,
  element: React.RefObject<HTMLElement | null>,
): ZoomControls {
  const state = useZoomState();
  const view = reclamp(viewFor(state, key), geometry);
  const layout = viewLayout(view, geometry.base, geometry.image);

  const latest = useRef(geometry);
  useLayoutEffect(() => {
    latest.current = geometry;
  });
  const pointer = useRef<Point | null>(null);
  const drag = useRef<{ id: number; last: Point } | null>(null);
  const [dragging, setDragging] = useState(false);

  // The store is the source of truth, so two wheel events in one frame both count.
  useEffect(() => {
    const current = (): { view: ZoomView; context: ZoomContext } => {
      const context = latest.current;
      return { view: reclamp(viewFor(zoomStore.get(), key), context), context };
    };
    const centre = (): Point => ({
      x: latest.current.viewport.width / 2,
      y: latest.current.viewport.height / 2,
    });
    const unregister = registerController({
      toggle() {
        const { view: now, context } = current();
        if (now.scale !== null) {
          setView(key, FIT_VIEW);
          return;
        }
        const at = pointer.current;
        const anchor =
          at && overPicture(viewLayout(now, context.base, context.image), context.image, at)
            ? at
            : centre();
        setView(key, zoomTo(now, context, anchor, levelScale(zoomStore.get().level, context.dpr)));
      },
      step(direction) {
        const { view: now, context } = current();
        setView(key, zoomBy(now, context, centre(), direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
      },
      setLevel(level) {
        const { view: now, context } = current();
        if (level === 'fit') {
          setView(key, FIT_VIEW);
          return;
        }
        zoomStore.update((state) => ({ ...state, level }));
        setView(key, zoomTo(now, context, centre(), levelScale(level, context.dpr)));
      },
    });
    return () => {
      unregister();
      clearView(key);
    };
  }, [key]);

  // Ctrl/Cmd + wheel, which Chromium also sends for a trackpad pinch. A native listener, because
  // React's wheel handlers are passive and the browser would zoom the page.
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = target.getBoundingClientRect();
      const context = latest.current;
      const now = reclamp(viewFor(zoomStore.get(), key), context);
      setView(
        key,
        zoomBy(
          now,
          context,
          { x: event.clientX - box.left, y: event.clientY - box.top },
          wheelZoomFactor(event),
        ),
      );
    };
    const onMove = (event: PointerEvent): void => {
      const box = target.getBoundingClientRect();
      pointer.current = { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const onLeave = (): void => {
      pointer.current = null;
    };
    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerleave', onLeave);
    return () => {
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerleave', onLeave);
    };
  }, [element, key]);

  const finish = (event: React.PointerEvent): void => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return {
    view,
    layout,
    dragging,
    panHandlers: {
      onPointerDown(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, last: { x: event.clientX, y: event.clientY } };
        setDragging(true);
      },
      onPointerMove(event) {
        const active = drag.current;
        if (active?.id !== event.pointerId) return;
        const delta = { x: event.clientX - active.last.x, y: event.clientY - active.last.y };
        active.last = { x: event.clientX, y: event.clientY };
        const context = latest.current;
        const now = reclamp(viewFor(zoomStore.get(), key), context);
        setView(key, panBy(now, context, delta));
      },
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}
