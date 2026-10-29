/**
 * Tile planning for images and renders bigger than the GPU's texture and
 * framebuffer limits (full-resolution export: up to 8256x5504, while
 * `MAX_TEXTURE_SIZE` can be as low as 8192). Pure functions so they can be
 * tested without a GL context.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One texture of the source image: the region it holds and the part of it that is its own ("core"). */
export interface SourceTile {
  /** Region uploaded to the texture: the core plus a 1 px border (for bilinear taps), clipped to the image. */
  texture: Rect;
  /** The pixels this tile is responsible for; cores partition the image. */
  core: Rect;
}

/** Texture border around a tile's core when a lens correction displaces red and blue (lateral CA). */
export const LENS_TILE_BORDER = 8;

/**
 * Splits a `width` x `height` image into textures of at most `maxTexture` pixels per side. `border`
 * pixels around each core are uploaded too, for bilinear taps and for samples displaced by lateral CA.
 */
export function planSourceTiles(
  width: number,
  height: number,
  maxTexture: number,
  border = 1,
): SourceTile[] {
  if (width <= maxTexture && height <= maxTexture) {
    const full = { x: 0, y: 0, w: width, h: height };
    return [{ texture: full, core: full }];
  }
  if (maxTexture < 4) throw new RangeError(`Texture size limit ${maxTexture} is too small to tile`);
  const step = maxTexture - 2 * border;
  const tiles: SourceTile[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const core = { x, y, w: Math.min(step, width - x), h: Math.min(step, height - y) };
      const tx = Math.max(0, x - border);
      const ty = Math.max(0, y - border);
      const texture = {
        x: tx,
        y: ty,
        w: Math.min(width, x + core.w + border) - tx,
        h: Math.min(height, y + core.h + border) - ty,
      };
      tiles.push({ texture, core });
    }
  }
  return tiles;
}

/**
 * The output rectangle a source core maps to when the image is rendered at
 * `outWidth` x `outHeight`. Rounding is on shared edges, so the rectangles of
 * all cores partition the output exactly.
 */
export function outputRectOfCore(
  core: Rect,
  source: { width: number; height: number },
  out: { width: number; height: number },
): Rect {
  const edge = (v: number, src: number, dst: number): number =>
    v >= src ? dst : Math.round((v * dst) / src);
  const x0 = edge(core.x, source.width, out.width);
  const x1 = edge(core.x + core.w, source.width, out.width);
  const y0 = edge(core.y, source.height, out.height);
  const y1 = edge(core.y + core.h, source.height, out.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Splits a rectangle into pieces of at most `maxSize` pixels per side. */
export function splitRect(rect: Rect, maxSize: number): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < rect.h; y += maxSize) {
    for (let x = 0; x < rect.w; x += maxSize) {
      out.push({
        x: rect.x + x,
        y: rect.y + y,
        w: Math.min(maxSize, rect.w - x),
        h: Math.min(maxSize, rect.h - y),
      });
    }
  }
  return out;
}
