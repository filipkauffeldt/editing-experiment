/*
 * The pointer callbacks below run from a drag, never during render. The refs
 * keep the live width and limits without a render on every mouse move, which
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
import { PANEL_WIDTH_SPECS, fitPanelWidth, layoutPanelWidths } from '../shared/panel-widths';
import { useAppState, useAppStore } from './store-context';

export type PanelSide = 'left' | 'right';

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
  width: number;
  dragging: boolean;
  handlers: PanelResizeHandlers;
  /** Put the panel back to its default width (the handle's double-click). */
  reset(): void;
}

interface DragState<Id extends PanelWidthId> {
  id: Id;
  pointerId: number;
  startX: number;
  startWidth: number;
  /** The latest width the drag asked for, so pointer up never saves a stale render. */
  width: number;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Widths of the side panels in one module. The preference lives in settings and
 * is only written when a drag ends; a smaller window re-clamps the shown width
 * without touching it. Every pointer event during a drag is captured by the
 * handle, so the panel contents never see it.
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
  const containerWidthRef = useRef(containerWidth);

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

  const ids = useMemo(() => definitions.map((definition) => definition.id), [definitions]);
  const widths = useMemo(
    () => layoutPanelWidths(ids, draft ?? preferred, containerWidth),
    [ids, draft, preferred, containerWidth],
  );
  const widthsRef = useRef(widths);

  // The event handlers run after a commit and read these; keeping them in refs
  // means a pointer move never waits for a render.
  useLayoutEffect(() => {
    preferredRef.current = preferred;
  }, [preferred]);
  useLayoutEffect(() => {
    containerWidthRef.current = containerWidth;
  }, [containerWidth]);
  useLayoutEffect(() => {
    widthsRef.current = widths;
  }, [widths]);

  // While a drag runs, the whole window shows the resize cursor and no text can
  // be selected, even when the pointer leaves the handle.
  const dragActive = dragging !== undefined;
  useLayoutEffect(() => {
    if (!dragActive) return;
    document.body.classList.add('panel-resizing');
    return () => document.body.classList.remove('panel-resizing');
  }, [dragActive]);

  const finishDrag = (id: Id, element: HTMLElement, pointerId: number): void => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    setDragging(undefined);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);

    const width = drag.width;
    const stored = preferredRef.current ?? {};
    const unchanged =
      width === stored[id] ||
      (stored[id] === undefined && width === PANEL_WIDTH_SPECS[id].defaultWidth);
    if (unchanged) {
      setDraft(undefined);
      return;
    }
    void store
      .saveSettings({ panelWidths: { ...stored, [id]: width } })
      .catch((cause: unknown) => {
        store.notify('error', `Could not save the panel width: ${messageOf(cause)}`);
      })
      .finally(() => setDraft(undefined));
  };

  const reset = (id: Id): void => {
    const stored = preferredRef.current ?? {};
    if (stored[id] === undefined) {
      setDraft(undefined);
      return;
    }
    const next: PanelWidths = { ...stored };
    delete next[id];
    const width =
      layoutPanelWidths(ids, next, containerWidthRef.current)[id] ??
      PANEL_WIDTH_SPECS[id].defaultWidth;
    setDraft({ ...next, [id]: width });
    void store
      .saveSettings({ panelWidths: next })
      .catch((cause: unknown) => {
        store.notify('error', `Could not save the panel width: ${messageOf(cause)}`);
      })
      .finally(() => setDraft(undefined));
  };

  const handlersFor = (definition: ResizablePanelDefinition<Id>): PanelResizeHandlers => {
    const { id, side } = definition;
    return {
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const startWidth = widthsRef.current[id] ?? PANEL_WIDTH_SPECS[id].defaultWidth;
        dragRef.current = {
          id,
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth,
          width: startWidth,
        };
        setDraft({ ...(preferredRef.current ?? {}) });
        setDragging(id);
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== id || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const delta = side === 'left' ? event.clientX - drag.startX : drag.startX - event.clientX;
        const others = definitions
          .filter((candidate) => candidate.id !== id)
          .map(
            (candidate) =>
              widthsRef.current[candidate.id] ?? PANEL_WIDTH_SPECS[candidate.id].defaultWidth,
          );
        const width = fitPanelWidth(id, drag.startWidth + delta, others, containerWidthRef.current);
        drag.width = width;
        setDraft((current) => ({ ...(current ?? preferredRef.current ?? {}), [id]: width }));
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
    panels[definition.id] = {
      width: widths[definition.id] ?? PANEL_WIDTH_SPECS[definition.id].defaultWidth,
      dragging: dragging === definition.id,
      handlers: handlersFor(definition),
      reset: () => reset(definition.id),
    };
  }

  return { containerRef, panels };
}
