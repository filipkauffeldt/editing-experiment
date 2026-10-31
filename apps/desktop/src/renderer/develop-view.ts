import type { Histogram } from '@ee/develop-gl';
import type { PhotoId } from '@ee/contracts';
import { useSyncExternalStore } from 'react';

/**
 * View-only develop tools that do not belong in the sidecar: the histogram, the
 * clipping overlay, before/after and the white balance picker. They are split
 * from `AppState` so a histogram update does not re-render the photo canvas
 * (which would schedule another frame at the histogram's rate).
 */

export type BeforeAfter = 'off' | 'before' | 'split';

export interface DevelopViewMode {
  clipShadows: boolean;
  clipHighlights: boolean;
  beforeAfter: BeforeAfter;
  /** Divider position, 0..1 from the left. */
  split: number;
  wbPicker: boolean;
  /** One-shot commands from the panel buttons, picked up by the canvas. */
  request?: { action: 'auto-tone' | 'auto-wb'; sequence: number };
}

export interface HistogramSnapshot {
  photoId: PhotoId;
  histogram: Histogram;
}

function createStore<T>(initial: T): {
  get(): T;
  set(next: T): void;
  update(updater: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
} {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
    update: (updater) => {
      value = updater(value);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const developViewStore = createStore<DevelopViewMode>({
  clipShadows: false,
  clipHighlights: false,
  beforeAfter: 'off',
  split: 0.5,
  wbPicker: false,
});

export const histogramStore = createStore<HistogramSnapshot | undefined>(undefined);

let actionSequence = 0;

export function useDevelopViewMode(): DevelopViewMode {
  return useSyncExternalStore(
    developViewStore.subscribe,
    developViewStore.get,
    developViewStore.get,
  );
}

export function useHistogram(photoId: PhotoId | undefined): Histogram | undefined {
  const snapshot = useSyncExternalStore(
    histogramStore.subscribe,
    histogramStore.get,
    histogramStore.get,
  );
  return snapshot !== undefined && snapshot.photoId === photoId ? snapshot.histogram : undefined;
}

export const setHistogram = (photoId: PhotoId, histogram: Histogram): void => {
  histogramStore.set({ photoId, histogram });
};

export const clearHistogram = (photoId?: PhotoId): void => {
  histogramStore.update((current) =>
    photoId === undefined || current?.photoId === photoId ? undefined : current,
  );
};

export const setClipping = (shadows: boolean, highlights: boolean): void => {
  developViewStore.update((current) => ({
    ...current,
    clipShadows: shadows,
    clipHighlights: highlights,
  }));
};

export const toggleClipping = (): void => {
  developViewStore.update((current) => {
    const on = current.clipShadows || current.clipHighlights;
    return { ...current, clipShadows: !on, clipHighlights: !on };
  });
};

export const toggleClipShadows = (): void => {
  developViewStore.update((current) => ({ ...current, clipShadows: !current.clipShadows }));
};

export const toggleClipHighlights = (): void => {
  developViewStore.update((current) => ({ ...current, clipHighlights: !current.clipHighlights }));
};

export const setBeforeAfter = (beforeAfter: BeforeAfter): void => {
  developViewStore.update((current) => ({ ...current, beforeAfter }));
};

/** `\` / Y: show the unedited photo, or go back to the current edit. */
export const toggleBefore = (): void => {
  developViewStore.update((current) => ({
    ...current,
    beforeAfter: current.beforeAfter === 'before' ? 'off' : 'before',
  }));
};

export const setSplit = (split: number): void => {
  const clamped = Number.isFinite(split) ? Math.min(1, Math.max(0, split)) : 0.5;
  developViewStore.update((current) => ({ ...current, split: clamped }));
};

export const setWbPicker = (wbPicker: boolean): void => {
  developViewStore.update((current) => ({ ...current, wbPicker }));
};

export const toggleWbPicker = (): void => {
  developViewStore.update((current) => ({ ...current, wbPicker: !current.wbPicker }));
};

export const cancelWbPicker = (): void => {
  developViewStore.update((current) =>
    current.wbPicker ? { ...current, wbPicker: false } : current,
  );
};

export const requestDevelopAction = (action: 'auto-tone' | 'auto-wb'): void => {
  actionSequence += 1;
  developViewStore.update((current) => ({
    ...current,
    request: { action, sequence: actionSequence },
  }));
};

export const clearDevelopAction = (sequence: number): void => {
  developViewStore.update((current) =>
    current.request?.sequence === sequence ? { ...current, request: undefined } : current,
  );
};
