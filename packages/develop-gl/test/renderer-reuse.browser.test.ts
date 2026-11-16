import type { EditParams } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevelopRenderer, type DevelopRenderer } from '../src/renderer';
import { makeImage, maxAbsDiff, sceneAt } from './support';

/**
 * One renderer, one context and one set of compiled programs serve many photos (Develop moves
 * through a burst without making a context per photo). What belongs to a photo must not outlive it:
 * the textures and framebuffers alive stay level however many photos are visited, and a photo
 * drawn after others looks exactly like the same photo drawn by a fresh renderer.
 */

type Kind = 'texture' | 'framebuffer' | 'renderbuffer' | 'program';
const KINDS: Kind[] = ['texture', 'framebuffer', 'renderbuffer', 'program'];

/** Counts the GL objects alive, by wrapping the create and delete calls of the context class. */
function trackObjects(): { live(): Record<Kind, number>; stop(): void } {
  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, unknown>;
  const alive: Record<Kind, Set<unknown>> = {
    texture: new Set(),
    framebuffer: new Set(),
    renderbuffer: new Set(),
    program: new Set(),
  };
  const originals = new Map<string, unknown>();
  for (const kind of KINDS) {
    const name = `${kind[0]?.toUpperCase()}${kind.slice(1)}`;
    const create = proto[`create${name}`] as (this: unknown) => unknown;
    const remove = proto[`delete${name}`] as (this: unknown, object: unknown) => void;
    originals.set(`create${name}`, create);
    originals.set(`delete${name}`, remove);
    proto[`create${name}`] = function (this: unknown) {
      const object = create.call(this);
      if (object) alive[kind].add(object);
      return object;
    };
    proto[`delete${name}`] = function (this: unknown, object: unknown) {
      alive[kind].delete(object);
      remove.call(this, object);
    };
  }
  return {
    live: () => ({
      texture: alive.texture.size,
      framebuffer: alive.framebuffer.size,
      renderbuffer: alive.renderbuffer.size,
      program: alive.program.size,
    }),
    stop() {
      for (const [name, original] of originals) proto[name] = original;
    },
  };
}

const canvasOf = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/** What the canvas shows, read back in the task that drew it (the browser has not composited yet). */
function shown(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d context');
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, copy.width, copy.height).data;
}

interface Photo {
  width: number;
  height: number;
  seed: number;
  params: EditParams;
}

/** Different sizes and shapes, some with the neighbourhood passes (which keep float targets), some without. */
const PHOTOS: Photo[] = [
  { width: 96, height: 64, seed: 1, params: { Exposure2012: 0.3, Clarity2012: 40 } },
  { width: 64, height: 96, seed: 2, params: { Contrast2012: 20, Sharpness: 60 } },
  { width: 80, height: 80, seed: 3, params: { Exposure2012: -0.4 } },
  { width: 128, height: 72, seed: 4, params: { Texture: 50, Dehaze: 30, Vibrance: 20 } },
  { width: 72, height: 128, seed: 5, params: { Saturation: -30, LuminanceSmoothing: 40 } },
];

const imageOf = (photo: Photo) =>
  makeImage(photo.width, photo.height, (x, y) => {
    const [r, g, b] = sceneAt(x / photo.width, y / photo.height);
    const k = 0.6 + 0.1 * photo.seed;
    return [r * k, g, b / k];
  });

let renderers: DevelopRenderer[] = [];
const create = (canvas: HTMLCanvasElement, grainSeed?: number): DevelopRenderer => {
  const renderer = createDevelopRenderer(canvas, { grainSeed });
  renderers.push(renderer);
  return renderer;
};
afterEach(() => {
  for (const renderer of renderers) renderer.dispose();
  renderers = [];
});

function draw(
  renderer: DevelopRenderer,
  canvas: HTMLCanvasElement,
  photo: Photo,
): Uint8ClampedArray {
  const { header, data } = imageOf(photo);
  renderer.configure({ grainSeed: photo.seed });
  renderer.setImage(header, data);
  renderer.render({ ...photo.params, GrainAmount: 20 });
  return shown(canvas);
}

describe('one renderer for many photos', () => {
  it('draws each photo as a fresh renderer does, whatever came before it', () => {
    const reused = canvasOf(96, 64);
    const renderer = create(reused);
    for (const photo of [...PHOTOS, ...PHOTOS].slice(0, 8)) {
      reused.width = photo.width;
      reused.height = photo.height;
      const afterOthers = draw(renderer, reused, photo);

      const fresh = canvasOf(photo.width, photo.height);
      const freshRenderer = create(fresh, photo.seed);
      const { header, data } = imageOf(photo);
      freshRenderer.setImage(header, data);
      freshRenderer.render({ ...photo.params, GrainAmount: 20 });
      expect(maxAbsDiff(afterOthers, shown(fresh)), `photo ${photo.seed}`).toBe(0);
      freshRenderer.dispose();
    }
  });

  it('keeps the textures and framebuffers alive level over many photos', () => {
    const tracker = trackObjects();
    try {
      const canvas = canvasOf(96, 64);
      const renderer = create(canvas);
      const atEnd: Record<Kind, number>[] = [];
      for (let i = 0; i < 60; i++) {
        // Every visit has a size no earlier one had, with the neighbourhood passes on, so a pool
        // that kept the textures of the sizes it has seen would grow with every photo.
        const base = PHOTOS[i % PHOTOS.length]!;
        const photo = { ...base, width: 64 + i * 2, height: 48 + i };
        canvas.width = photo.width;
        canvas.height = photo.height;
        draw(renderer, canvas, photo);
        // The canvas of the Develop view lets go of the photo when it leaves.
        if (i % 2 === 0) renderer.release();
        atEnd.push(tracker.live());
      }
      // The photos alternate between released and not, and between lighter and heavier edits, so
      // the same visit repeats every ten photos. Once the first rounds are through, it leaves
      // exactly what it left ten photos earlier.
      for (let i = 20; i < atEnd.length; i++) {
        expect(atEnd[i], `visit ${i}`).toEqual(atEnd[i - 10]);
      }

      // A released photo holds none of its own textures: only the fixed ones are left.
      renderer.release();
      const idle = tracker.live();
      expect(idle.texture).toBeLessThan(Math.max(...atEnd.map((c) => c.texture)));
      const programs = idle.program;
      draw(renderer, canvas, { ...PHOTOS[0]!, width: canvas.width, height: canvas.height });
      renderer.release();
      expect(tracker.live()).toEqual(idle);
      // The compiled programs are the ones from before: no new program for a new photo.
      expect(tracker.live().program).toBe(programs);
    } finally {
      tracker.stop();
    }
  });

  it('frees every texture and program on dispose', () => {
    const tracker = trackObjects();
    try {
      const canvas = canvasOf(96, 64);
      const renderer = createDevelopRenderer(canvas);
      for (const photo of PHOTOS) draw(renderer, canvas, photo);
      renderer.dispose();
      expect(tracker.live()).toEqual({ texture: 0, framebuffer: 0, renderbuffer: 0, program: 0 });
    } finally {
      tracker.stop();
    }
  });

  it('shows nothing of the previous photo once it is released', () => {
    const canvas = canvasOf(96, 64);
    const renderer = create(canvas);
    const bright = makeImage(96, 64, () => [0.9, 0.9, 0.9]);
    renderer.setImage(bright.header, bright.data);
    renderer.render({});
    expect(shown(canvas)[0]).toBeGreaterThan(200);
    renderer.release();
    expect(shown(canvas)[0]).toBeLessThan(5);
    expect(() => renderer.render({})).toThrow(/No image/);
  });

  it('recovers from a lost context and tells the callback it was last given', async () => {
    const canvas = canvasOf(96, 64);
    const renderer = create(canvas);
    const stale: string[] = [];
    const current: string[] = [];
    renderer.configure({ onContextLost: () => stale.push('lost') });
    // A later photo's canvas takes over the callback.
    renderer.configure({ onContextLost: () => current.push('lost') });
    draw(renderer, canvas, PHOTOS[0]!);

    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    expect(extension).toBeTruthy();
    extension?.loseContext();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renderer.contextLost).toBe(true);
    expect(current).toEqual(['lost']);
    expect(stale).toEqual([]);

    const restored = new Promise<void>((resolve) =>
      canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true }),
    );
    extension?.restoreContext();
    await restored;
    // The renderer's own listener is added first, so it has recreated its resources by now.
    expect(renderer.contextLost).toBe(false);

    const photo = PHOTOS[1]!;
    canvas.width = photo.width;
    canvas.height = photo.height;
    const after = draw(renderer, canvas, photo);
    const fresh = canvasOf(photo.width, photo.height);
    const freshRenderer = create(fresh, photo.seed);
    const { header, data } = imageOf(photo);
    freshRenderer.setImage(header, data);
    freshRenderer.render({ ...photo.params, GrainAmount: 20 });
    expect(maxAbsDiff(after, shown(fresh))).toBe(0);
  });
});
