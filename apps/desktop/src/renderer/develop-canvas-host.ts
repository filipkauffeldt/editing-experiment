import { createDevelopRenderer, type DevelopRenderer } from '@ee/develop-gl';
import type { AppStore } from './store';

/**
 * The one WebGL canvas, context and set of compiled programs of the Develop view. Moving to
 * another photo mounts a new `PhotoCanvas` tree, but not a new context: making one and compiling
 * the develop shader for it took most of the time between an arrow key and the next photo. The
 * view mounts the host's canvas into whichever tree is current, and lets go of the previous
 * photo's textures and pixels when that tree goes (`DevelopRenderer.release`).
 */
export interface DevelopCanvasHost {
  readonly canvas: HTMLCanvasElement;
  /** Null when WebGL2 is not available or the context could not be made (see `error`). */
  readonly renderer: DevelopRenderer | null;
  readonly error: string | undefined;
}

function createDevelopCanvasHost(store: AppStore): DevelopCanvasHost {
  const canvas = document.createElement('canvas');
  let renderer: DevelopRenderer | null = null;
  let error: string | undefined;
  if (typeof WebGL2RenderingContext === 'undefined') {
    error = 'WebGL2 is not available';
  } else {
    try {
      renderer = createDevelopRenderer(canvas, {
        onNeighbourhoodUnavailable: () =>
          store.notifyOnce(
            'develop-float',
            'info',
            'This GPU cannot draw Texture, Clarity, Dehaze, sharpening or noise reduction (no float render targets), so the preview skips them. Exports still apply them.',
          ),
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  return {
    canvas,
    renderer,
    error,
  };
}

const hosts = new WeakMap<AppStore, DevelopCanvasHost>();

/**
 * The store's host, made on first use and kept for the life of the window: leaving Develop and
 * coming back finds the context and the compiled programs where they were. It holds no photo while
 * no photo canvas is mounted (that canvas lets go of it), only the programs and a canvas.
 */
export function developCanvasHostFor(store: AppStore): DevelopCanvasHost {
  let host = hosts.get(store);
  if (!host) {
    host = createDevelopCanvasHost(store);
    hosts.set(store, host);
  }
  return host;
}
