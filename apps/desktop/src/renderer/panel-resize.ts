/*
 * The pointer callbacks below run from a drag, never during render. The refs
 * keep the live size and limits without a render on every mouse move, which
 * the compiler's refs rule cannot see through when the handlers are built here.
 */
/* eslint-disable react-hooks/refs */
import type { PanelWidthId, PanelWidths } from '@ee/contracts';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  PANEL_SIZE_SPECS,
  fitPanelSize,
  layoutPanelSizes,
  panelSizeLimits,
  type PanelContainerSize,
} from '../shared/panel-widths';
import { useAppState, useAppStore } from './store-context';

export type PanelSide = 'left' | 'right' | 'top' | 'bottom';

/** Which of the view's panels is where; the side decides which way a drag widens it. */
export interface ResizablePanelDefinition<Id extends PanelWidthId = PanelWidthId> {
  id: Id;
  side: PanelSide;
}

export interface PanelResizeHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void;
  onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>): void;
}

export interface PanelResizeController {
  size: number;
  min: number;
  max: number;
  dragging: boolean;
  handlers: PanelResizeHandlers;
  /** Put the panel back to its default size (the handle's double-click). */
  reset(): void;
  /** Move the edge by `delta` pixels: positive makes the panel wider or taller. */
  nudge(delta: number): void;
}

interface DragState<Id extends PanelWidthId> {
  id: Id;
  pointerId: number;
  startX: number;
  startY: number;
  startSize: number;
  /** The latest size the drag asked for, so pointer up never saves a stale render. */
  size: number;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const verticalSide = (side: PanelSide): boolean => side === 'top' || side === 'bottom';

/**
 * Sizes of the side panels and the film strip in one view. The preference lives
 * in settings and is only written when a drag ends or a key moves the edge; a
 * smaller window re-clamps the shown size without touching it. Every pointer
 * event during a drag is captured by the handle, so the panel contents never
 * see it.
 */
export function usePanelLayout<Id extends PanelWidthId>(
  definitions: readonly ResizablePanelDefinition<Id>[],
): {
  containerRef: RefObject<HTMLDivElement | null>;
  panels: Record<Id, PanelResizeController>;
} {
  const store = useAppStore();
  const settings = useAppState().settings;
  const preferred = settings?.panelWidths;
  const preferredRef = useRef(preferred);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>();
  const [windowHeight, setWindowHeight] = useState<number>();

  const [draft, setDraft] = useState<PanelWidths>();
  const [dragging, setDragging] = useState<Id>();
  const dragRef = useRef<DragState<Id> | null>(null);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = (): void => setContainerWidth(element.clientWidth || undefined);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A bottom strip's room is the window height, so the one-third cap follows a window resize.
  useLayoutEffect(() => {
    const measure = (): void => setWindowHeight(window.innerHeight || undefined);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const ids = useMemo(() => definitions.map((definition) => definition.id), [definitions]);
  const container = useMemo<PanelContainerSize>(
    () => ({ width: containerWidth, height: windowHeight }),
    [containerWidth, windowHeight],
  );
  const sizes = useMemo(
    () => layoutPanelSizes(ids, draft ?? preferred, container),
    [ids, draft, preferred, container],
  );
  const sizesRef = useRef(sizes);
  const containerSizeRef = useRef(container);

  // The event handlers run after a commit and read these; keeping them in refs
  // means a pointer move never waits for a render.
  useLayoutEffect(() => {
    preferredRef.current = preferred;
  }, [preferred]);
  useLayoutEffect(() => {
    containerSizeRef.current = container;
  }, [container]);
  useLayoutEffect(() => {
    sizesRef.current = sizes;
  }, [sizes]);

  // While a drag runs, the whole window shows the axis's resize cursor and no
  // text can be selected, even when the pointer leaves the handle.
  const axis = dragging === undefined ? undefined : PANEL_SIZE_SPECS[dragging].axis;
  useLayoutEffect(() => {
    if (axis === undefined) return;
    const classes = [
      'panel-resizing',
      axis === 'vertical' ? 'panel-resizing-y' : 'panel-resizing-x',
    ];
    for (const name of classes) document.body.classList.add(name);
    return () => {
      for (const name of classes) document.body.classList.remove(name);
    };
  }, [axis]);

  const saveSize = (id: Id, size: number): void => {
    const stored = preferredRef.current ?? {};
    const unchanged =
      size === stored[id] ||
      (stored[id] === undefined && size === PANEL_SIZE_SPECS[id].defaultSize);
    if (unchanged) {
      setDraft(undefined);
      return;
    }
    void store
      .saveSettings({ panelWidths: { ...stored, [id]: size } })
      .catch((cause: unknown) => {
        store.notify('error', `Could not save the panel size: ${messageOf(cause)}`);
      })
      .finally(() => setDraft(undefined));
  };

  const finishDrag = (id: Id, element: HTMLElement, pointerId: number): void => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    setDragging(undefined);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    saveSize(id, drag.size);
  };

  const reset = (id: Id): void => {
    const stored = preferredRef.current ?? {};
    if (stored[id] === undefined) {
      setDraft(undefined);
      return;
    }
    const next: PanelWidths = { ...stored };
    delete next[id];
    const size =
      layoutPanelSizes(ids, next, containerSizeRef.current)[id] ?? PANEL_SIZE_SPECS[id].defaultSize;
    setDraft({ ...next, [id]: size });
    void store
      .saveSettings({ panelWidths: next })
      .catch((cause: unknown) => {
        store.notify('error', `Could not save the panel size: ${messageOf(cause)}`);
      })
      .finally(() => setDraft(undefined));
  };

  const nudge = (id: Id, delta: number): void => {
    const spec = PANEL_SIZE_SPECS[id];
    const others = definitions
      .filter((candidate) => candidate.id !== id)
      .map(
        (candidate) => sizesRef.current[candidate.id] ?? PANEL_SIZE_SPECS[candidate.id].defaultSize,
      );
    const current = sizesRef.current[id] ?? spec.defaultSize;
    const size = fitPanelSize(id, current + delta, others, containerSizeRef.current);
    if (size === current) return;
    setDraft((shown) => ({ ...(shown ?? preferredRef.current ?? {}), [id]: size }));
    saveSize(id, size);
  };

  const handlersFor = (definition: ResizablePanelDefinition<Id>): PanelResizeHandlers => {
    const { id, side } = definition;
    const vertical = verticalSide(side);
    return {
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const startSize = sizesRef.current[id] ?? PANEL_SIZE_SPECS[id].defaultSize;
        dragRef.current = {
          id,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startSize,
          size: startSize,
        };
        setDraft({ ...(preferredRef.current ?? {}) });
        setDragging(id);
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== id || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const pointer = vertical ? event.clientY : event.clientX;
        const start = vertical ? drag.startY : drag.startX;
        const grows = side === 'left' || side === 'top' ? pointer - start : start - pointer;
        const others = definitions
          .filter((candidate) => candidate.id !== id)
          .map(
            (candidate) =>
              sizesRef.current[candidate.id] ?? PANEL_SIZE_SPECS[candidate.id].defaultSize,
          );
        const size = fitPanelSize(id, drag.startSize + grows, others, containerSizeRef.current);
        drag.size = size;
        setDraft((current) => ({ ...(current ?? preferredRef.current ?? {}), [id]: size }));
      },
      onPointerUp: (event) => {
        finishDrag(id, event.currentTarget, event.pointerId);
      },
      onPointerCancel: (event) => {
        finishDrag(id, event.currentTarget, event.pointerId);
      },
      onLostPointerCapture: (event) => {
        finishDrag(id, event.currentTarget, event.pointerId);
      },
    };
  };

  const panels = {} as Record<Id, PanelResizeController>;
  for (const definition of definitions) {
    const limits = panelSizeLimits(definition.id, container);
    panels[definition.id] = {
      size: sizes[definition.id] ?? PANEL_SIZE_SPECS[definition.id].defaultSize,
      min: limits.min,
      max: limits.max,
      dragging: dragging === definition.id,
      handlers: handlersFor(definition),
      reset: () => reset(definition.id),
      nudge: (delta) => nudge(definition.id, delta),
    };
  }

  return { containerRef, panels };
}
