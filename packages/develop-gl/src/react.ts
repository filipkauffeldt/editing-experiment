import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { LinearImageBuffer } from './image';
import {
  createDevelopRenderer,
  type DevelopRenderer,
  type DevelopRendererOptions,
} from './renderer';

export interface DevelopImage {
  header: LinearImageHeader;
  data: LinearImageBuffer;
}

export interface DevelopPreview {
  /** The renderer once the canvas is mounted (e.g. to call `renderToRGBA` for export), else null. */
  renderer: DevelopRenderer | null;
  /** Why the renderer could not be created (no WebGL2) or the image could not be uploaded. */
  error: Error | null;
}

/**
 * Keeps a develop preview on `canvasRef` up to date: creates the renderer with the
 * canvas, uploads `image` when it changes (pass a stable object per photo) and
 * re-renders whenever `params` changes. Set the canvas `width`/`height` to the
 * preview resolution; the image is scaled to fill it.
 */
export function useDevelopPreview(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  image: DevelopImage | null,
  params: EditParams,
  options?: DevelopRendererOptions,
): DevelopPreview {
  const [renderer, setRenderer] = useState<DevelopRenderer | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const latest = useRef({ params, options });
  latest.current = { params, options };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let created: DevelopRenderer;
    try {
      created = createDevelopRenderer(canvas, latest.current.options);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    setRenderer(created);
    setError(null);
    return () => {
      created.dispose();
      setRenderer(null);
    };
  }, [canvasRef]);

  useEffect(() => {
    if (!renderer || !image) return;
    try {
      renderer.setImage(image.header, image.data);
      renderer.render(latest.current.params);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [renderer, image]);

  useEffect(() => {
    if (!renderer || !image) return;
    try {
      renderer.render(params);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [renderer, image, params]);

  return { renderer, error };
}
