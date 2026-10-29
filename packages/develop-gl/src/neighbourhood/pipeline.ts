import { MEASURE_TAPS } from '../cpu';
import { DevelopGlError } from '../errors';
import type { DevelopUniforms } from '../params';
import { splitRect, type Rect } from '../tiling';
import { bandThresholds, blockGrid, estimateNoise, type NoiseLevels } from './denoise';
import {
  BLUR_FRAGMENT,
  DOWN_FRAGMENT,
  FIELDS_FRAGMENT,
  LOCAL_FRAGMENT,
  NOISE_PROBE_FRAGMENT,
  NR_BAND_FRAGMENT,
  NR_FINISH_FRAGMENT,
  NR_PREP_FRAGMENT,
  NR_UP_FRAGMENT,
  RESOLVE_FRAGMENT,
  SHARPEN_FRAGMENT,
} from './glsl';
import { copySize, measureHaze, type HazeMeasure } from './haze';
import { clarityLevel, type LocalGeometry } from './local';
import { dehazeOmega, hasDenoise, hasLocalContrast, type NeighbourhoodParams } from './params';
import { createProgram, ImagePool, PassRunner, type GlProgram, type Image } from './passes';
import { makePlane } from './pyramid';
import { gaussianKernel } from './sharpen';
import { CLARITY, DENOISE, LOCAL_LEVELS, MAX_LEVEL, TILE_ALIGN } from './tuning';

interface Size {
  width: number;
  height: number;
}

/** What the renderer does for the pipeline: the passes that need the source image and the crop mapping. */
export interface PipelineHost {
  /**
   * Draws the base pass (source -> white balance -> exposure, with the analysis
   * value in alpha) for the output-space `region` into `target`. With `measure`
   * the whole photo is drawn with an identity mapping at Exposure 0 into a
   * `buffer`-sized target instead.
   */
  drawBase(runner: PassRunner, target: Image, region: Rect, options: BaseOptions): void;
  /** Sets the develop chain's uniforms (tone, curve, colour) on `program`. */
  applyDevelop(program: GlProgram, u: DevelopUniforms): void;
  /** Sets the output -> source mapping uniforms on `program`. */
  applyMapping(program: GlProgram, out: Size): void;
}

export interface BaseOptions {
  taps: number;
  /** Output pixels per target pixel along each axis (the whole-output level 3 is drawn at 8). */
  posScale: number;
  posMax: [number, number];
  measure: boolean;
  /** The full output the mapping scales to (the copy's size for `measure`). */
  buffer: Size;
}

export interface PipelineInput {
  n: NeighbourhoodParams;
  u: DevelopUniforms;
  out: Size;
  sourceSize: Size;
  geometry: { scale: number; fullLongEdge: number };
  /** `<image id>|<everything else that changes the base image>`: crop, output size, white balance, exposure. */
  baseKey: string;
  /** Keep the stages for the next call (live preview); exports free them. */
  cache: boolean;
}

export interface FinalTarget {
  /** `null` is the canvas. */
  framebuffer: WebGLFramebuffer | null;
  /** Window coordinates of the core's pixels in the target. */
  viewport: Rect;
  /** True when row 0 of the viewport is at the bottom (the canvas). */
  flipY: boolean;
}

/** Output pixels each stage reads around a pixel; tiles need this much overlap to match a whole-image render. */
export const HALO = { denoise: 160, local: 32, sharpen: 16 } as const;

/** The overlap (a multiple of the tile alignment) around each tile for these controls. */
export function haloFor(n: NeighbourhoodParams): number {
  let halo = 0;
  if (hasDenoise(n)) halo += HALO.denoise;
  if (hasLocalContrast(n)) halo += HALO.local;
  if (n.sharpen) halo += HALO.sharpen;
  return Math.ceil(halo / TILE_ALIGN) * TILE_ALIGN;
}

/**
 * The halo the pipeline uses at this scale: sharpening needs none when its blur
 * is too small to change anything.
 */
export function effectiveHalo(n: NeighbourhoodParams, scale: number): number {
  const kernel = n.sharpen ? gaussianKernel(n.sharpen.sigma * scale) : new Float32Array(0);
  return haloFor({ ...n, sharpen: kernel.length > 0 ? n.sharpen : null });
}

/** Splits the output into tile cores whose size leaves room for the halo within `maxTile`. */
export function planCores(out: Size, maxTile: number, halo: number): Rect[] {
  const core = Math.max(TILE_ALIGN, Math.floor((maxTile - 2 * halo) / TILE_ALIGN) * TILE_ALIGN);
  return splitRect({ x: 0, y: 0, w: out.width, h: out.height }, core);
}

interface Prefix {
  region: Rect;
  /** Linear RGB with the analysis value in alpha, noise reduced. */
  lin: Image;
  /** Pyramid levels 1..LOCAL_LEVELS (analysis value in .r). */
  levels: Image[];
  /** Cached fields of Texture (.r) and Clarity (.rgba), made on first use. */
  fields: { texture?: Image; clarity?: Image };
}

interface Coarse {
  /** Levels LOCAL_LEVELS+1..MAX_LEVEL. */
  levels: Image[];
}

interface Measured extends HazeMeasure {
  cacheKey: string;
  densityTexture: WebGLTexture;
}

interface Cache {
  key: string;
  prefix: Prefix;
  coarse: Coarse | undefined;
}

const ceilDiv = (n: number, d: number): number => Math.ceil(n / d);

export interface NeighbourhoodPipeline {
  /**
   * Renders `cores` (a partition of the output) through the neighbourhood
   * stages. `final` says where each core's pixels go; `after` runs once its
   * pixels are drawn (to read them back). A single core with the same
   * `baseKey` and noise reduction as the last call reuses that call's base,
   * noise reduction and pyramid.
   */
  run(
    input: PipelineInput,
    cores: Rect[],
    final: (core: Rect) => FinalTarget,
    after?: (core: Rect) => void,
  ): void;
  /** Drops cached stages (a new image, a lost context). */
  invalidate(): void;
  dispose(): void;
}

export function createNeighbourhoodPipeline(
  gl: WebGL2RenderingContext,
  host: PipelineHost,
): NeighbourhoodPipeline {
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new DevelopGlError(
      'Texture, Clarity, Dehaze, sharpening and noise reduction need EXT_color_buffer_float',
    );
  }
  const pool = new ImagePool(gl);
  const runner = new PassRunner(gl);
  const programs = new Map<string, GlProgram>();
  const program = (name: string, source: string): GlProgram => {
    let p = programs.get(name);
    if (!p) {
      p = createProgram(gl, source);
      programs.set(name, p);
    }
    return p;
  };
  const P = {
    down: () => program('down', DOWN_FRAGMENT),
    nrPrep: () => program('nrPrep', NR_PREP_FRAGMENT),
    nrBand: () => program('nrBand', NR_BAND_FRAGMENT),
    nrUp: () => program('nrUp', NR_UP_FRAGMENT),
    nrFinish: () => program('nrFinish', NR_FINISH_FRAGMENT),
    probe: () => program('probe', NOISE_PROBE_FRAGMENT),
    fields: () => program('fields', FIELDS_FRAGMENT),
    local: () => program('local', LOCAL_FRAGMENT),
    resolve: () => program('resolve', RESOLVE_FRAGMENT),
    blur: () => program('blur', BLUR_FRAGMENT),
    sharpen: () => program('sharpen', SHARPEN_FRAGMENT),
  };

  let measured: Measured | undefined;
  let cache: Cache | undefined;

  const freePrefix = (prefix: Prefix): void => {
    pool.release(prefix.lin);
    for (const level of prefix.levels) pool.release(level);
    pool.release(prefix.fields.texture);
    pool.release(prefix.fields.clarity);
  };
  const freeCoarse = (coarse: Coarse | undefined): void => {
    if (coarse) for (const level of coarse.levels) pool.release(level);
  };
  const clearCache = (): void => {
    if (!cache) return;
    freePrefix(cache.prefix);
    freeCoarse(cache.coarse);
    cache = undefined;
  };

  /** `src` halved once more; `fromAlpha` when `src` is the base image (analysis value in alpha). */
  function down(src: Image, fromAlpha: boolean): Image {
    const target = pool.acquire(ceilDiv(src.w, 2), ceilDiv(src.h, 2));
    runner.run(P.down(), [src], target, (g) => {
      g.uniform1i(P.down().loc('u_src'), 0);
      g.uniform1i(P.down().loc('u_fromAlpha'), fromAlpha ? 1 : 0);
    });
    return target;
  }

  /** The haze measurement of the whole photo, cached per image and white balance. */
  function measure(input: PipelineInput): Measured {
    const key = JSON.stringify([
      input.baseKey.split('|')[0],
      input.u.multipliers,
      input.u.colorMatrix,
    ]);
    if (measured?.cacheKey === key) return measured;
    const size = copySize(input.sourceSize.width, input.sourceSize.height);
    const image = pool.acquire(size.width, size.height, 'rgba32f');
    const smaller = size.width < input.sourceSize.width || size.height < input.sourceSize.height;
    host.drawBase(
      runner,
      image,
      { x: 0, y: 0, w: size.width, h: size.height },
      {
        taps: smaller ? MEASURE_TAPS : 1,
        posScale: 1,
        posMax: [1e9, 1e9],
        measure: true,
        buffer: { width: size.width, height: size.height },
      },
    );
    const plane = makePlane(size.width, size.height, 4);
    runner.bindTarget(image);
    gl.readPixels(0, 0, size.width, size.height, gl.RGBA, gl.FLOAT, plane.data);
    pool.release(image);
    const haze = measureHaze(plane);
    if (measured) gl.deleteTexture(measured.densityTexture);
    const texture = gl.createTexture();
    if (!texture) throw new DevelopGlError('Could not create texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16F,
      haze.density.w,
      haze.density.h,
      0,
      gl.RED,
      gl.FLOAT,
      haze.density.data,
    );
    measured = { ...haze, cacheKey: key, densityTexture: texture };
    return measured;
  }

  /** Linear RGB to the noise reduction space, and its first coarser level. */
  function nrBase(lin: Image): { p0: Image; p1: Image } {
    const p0 = pool.acquire(lin.w, lin.h);
    runner.run(P.nrPrep(), [lin], p0, (g) => g.uniform1i(P.nrPrep().loc('u_lin'), 0));
    return { p0, p1: down(p0, false) };
  }

  /** Block RMS of the finest band for the blocks whose corner is in `core`. */
  function probe(p0: Image, p1: Image, core: Rect, region: Rect, out: Size): number[] {
    const grid = blockGrid(out.width, out.height);
    if (grid.xs.length === 0 || grid.ys.length === 0) return [];
    const target = pool.acquire(grid.xs.length, grid.ys.length, 'rgba32f');
    const prog = P.probe();
    runner.run(prog, [p0, p1], target, (g) => {
      g.uniform1i(prog.loc('u_fine'), 0);
      g.uniform1i(prog.loc('u_coarse'), 1);
      const xs = new Float32Array(DENOISE.maxBlocksX);
      const ys = new Float32Array(DENOISE.maxBlocksY);
      xs.set(grid.xs);
      ys.set(grid.ys);
      g.uniform1fv(prog.loc('u_blockX'), xs);
      g.uniform1fv(prog.loc('u_blockY'), ys);
      g.uniform2i(prog.loc('u_blocks'), grid.xs.length, grid.ys.length);
      g.uniform2f(prog.loc('u_tileOrigin'), region.x, region.y);
      g.uniform2f(prog.loc('u_coreMin'), core.x, core.y);
      g.uniform2f(prog.loc('u_coreMax'), core.x + core.w, core.y + core.h);
    });
    const data = new Float32Array(grid.xs.length * grid.ys.length * 4);
    gl.readPixels(0, 0, grid.xs.length, grid.ys.length, gl.RGBA, gl.FLOAT, data);
    pool.release(target);
    const blocks: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] ?? -1) >= 0) blocks.push(data[i] ?? 0, data[i + 1] ?? 0);
    }
    return blocks;
  }

  /** Noise reduction of `lin`; returns the denoised image (alpha: analysis value) and releases `lin`. */
  function denoiseImage(lin: Image, input: PipelineInput, noise: NoiseLevels): Image {
    const t = bandThresholds(noise, input.n.luma, input.n.chroma);
    const { p0, p1 } = nrBase(lin);
    const chain: Image[] = [p0, p1];
    for (let l = 1; l < DENOISE.levels; l++) chain.push(down(chain[l] as Image, false));
    let d = chain[DENOISE.levels] as Image;
    const temporaries: Image[] = [];
    for (let l = DENOISE.levels - 1; l >= 0; l--) {
      const fine = chain[l] as Image;
      const band = pool.acquire(fine.w, fine.h);
      runner.run(P.nrBand(), [fine, chain[l + 1] as Image], band, (g) => {
        g.uniform1i(P.nrBand().loc('u_fine'), 0);
        g.uniform1i(P.nrBand().loc('u_coarse'), 1);
      });
      const next = pool.acquire(fine.w, fine.h);
      runner.run(P.nrUp(), [band, d], next, (g) => {
        g.uniform1i(P.nrUp().loc('u_band'), 0);
        g.uniform1i(P.nrUp().loc('u_coarse'), 1);
        g.uniform1f(P.nrUp().loc('u_lumaThreshold'), t.luma[l] ?? 0);
        g.uniform1f(P.nrUp().loc('u_chromaThreshold'), t.chroma[l] ?? 0);
      });
      temporaries.push(band, next);
      d = next;
    }
    const out = pool.acquire(lin.w, lin.h);
    runner.run(P.nrFinish(), [d], out, (g) => g.uniform1i(P.nrFinish().loc('u_d'), 0));
    for (const image of [...chain, ...temporaries]) pool.release(image);
    pool.release(lin);
    return out;
  }

  /** Measures the noise over all `cores`: each block is measured by the core that contains its corner. */
  function measureNoise(input: PipelineInput, cores: Rect[], halo: number): NoiseLevels {
    const blocks: number[] = [];
    for (const core of cores) {
      const region = regionOf(core, input.out, halo);
      const lin = pool.acquire(region.w, region.h);
      host.drawBase(runner, lin, region, normalBase(input.out));
      const { p0, p1 } = nrBase(lin);
      blocks.push(...probe(p0, p1, core, region, input.out));
      pool.release(lin);
      pool.release(p0);
      pool.release(p1);
    }
    return estimateNoise(blocks);
  }

  const normalBase = (out: Size): BaseOptions => ({
    taps: 1,
    posScale: 1,
    posMax: [1e9, 1e9],
    measure: false,
    buffer: out,
  });

  function regionOf(core: Rect, out: Size, halo: number): Rect {
    const x0 = Math.max(0, core.x - halo);
    const y0 = Math.max(0, core.y - halo);
    const x1 = Math.min(out.width, core.x + core.w + halo);
    const y1 = Math.min(out.height, core.y + core.h + halo);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Base image of a region, noise reduced when asked, and its local pyramid levels. */
  function buildPrefix(
    input: PipelineInput,
    core: Rect,
    halo: number,
    noise: NoiseLevels | undefined,
    wantLevels: boolean,
  ): Prefix {
    const region = regionOf(core, input.out, halo);
    let lin = pool.acquire(region.w, region.h);
    host.drawBase(runner, lin, region, normalBase(input.out));
    if (hasDenoise(input.n)) {
      let levels = noise;
      if (!levels) {
        // One core: every block is in it, so measure on this very base image.
        const { p0, p1 } = nrBase(lin);
        levels = estimateNoise(probe(p0, p1, core, region, input.out));
        pool.release(p0);
        pool.release(p1);
      }
      lin = denoiseImage(lin, input, levels);
    }
    const levels: Image[] = [];
    if (wantLevels) {
      let previous = lin;
      for (let k = 1; k <= LOCAL_LEVELS; k++) {
        previous = down(previous, k === 1);
        levels.push(previous);
      }
    }
    return { region, lin, levels, fields: {} };
  }

  /** Levels above the local ones, from this core's level 3 (one core) or a render of the whole output (several). */
  function buildCoarse(input: PipelineInput, prefix: Prefix | undefined): Coarse {
    const levels: Image[] = [];
    let previous: Image;
    let fromAlpha = false;
    let temporary: Image | undefined;
    if (prefix) {
      previous = prefix.levels[LOCAL_LEVELS - 1] as Image;
    } else {
      const f = 2 ** LOCAL_LEVELS;
      const w = ceilDiv(input.out.width, f);
      const h = ceilDiv(input.out.height, f);
      previous = pool.acquire(w, h);
      temporary = previous;
      host.drawBase(
        runner,
        previous,
        { x: 0, y: 0, w, h },
        {
          taps: f,
          posScale: f,
          posMax: [input.out.width - 0.5, input.out.height - 0.5],
          measure: false,
          buffer: input.out,
        },
      );
      fromAlpha = true;
    }
    for (let k = LOCAL_LEVELS + 1; k <= MAX_LEVEL; k++) {
      previous = down(previous, fromAlpha);
      fromAlpha = false;
      levels.push(previous);
    }
    pool.release(temporary);
    return { levels };
  }

  const placement = (
    g: WebGL2RenderingContext,
    prog: GlProgram,
    viewport: Rect,
    offset: { x: number; y: number },
    flipY: boolean,
  ): void => {
    g.uniform2f(prog.loc('u_viewOrigin'), viewport.x, viewport.y);
    g.uniform1f(prog.loc('u_viewHeight'), viewport.h);
    g.uniform2f(prog.loc('u_coreOffset'), offset.x, offset.y);
    g.uniform1f(prog.loc('u_flipY'), flipY ? 1 : 0);
  };

  /** Makes the cached fields Texture and Clarity need, once per prefix. */
  function ensureFields(input: PipelineInput, prefix: Prefix, coarse: Coarse | undefined): void {
    const { n } = input;
    const needTexture = n.texture !== 0 && !prefix.fields.texture;
    const needClarity = n.clarity !== null && !prefix.fields.clarity;
    if (!needTexture && !needClarity) return;
    const prog = P.fields();
    const levelImages: Image[] = [prefix.lin, ...prefix.levels, ...(coarse?.levels ?? [])];
    const sizes = new Float32Array(2 * (MAX_LEVEL + 1));
    const origins = new Float32Array(2 * (MAX_LEVEL + 1));
    levelImages.forEach((image, k) => {
      sizes[2 * k] = image.w;
      sizes[2 * k + 1] = image.h;
      const local = k <= LOCAL_LEVELS;
      origins[2 * k] = local ? prefix.region.x : 0;
      origins[2 * k + 1] = local ? prefix.region.y : 0;
    });
    const geometry: LocalGeometry = {
      logScale: Math.log2(input.geometry.scale),
      fullLongEdge: input.geometry.fullLongEdge,
    };
    const run = (mode: number): Image => {
      const target = pool.acquire(prefix.region.w, prefix.region.h);
      runner.run(prog, levelImages, target, (g) => {
        ['u_lin', 'u_l1', 'u_l2', 'u_l3', 'u_g4', 'u_g5', 'u_g6', 'u_g7', 'u_g8'].forEach(
          (name, unit) => g.uniform1i(prog.loc(name), unit),
        );
        g.uniform2f(prog.loc('u_tileOrigin'), prefix.region.x, prefix.region.y);
        g.uniform2fv(prog.loc('u_levelSize'), sizes);
        g.uniform2fv(prog.loc('u_levelOrigin'), origins);
        g.uniform1i(prog.loc('u_mode'), mode);
        g.uniform1f(prog.loc('u_logScale'), geometry.logScale);
        g.uniform1fv(
          prog.loc('u_clarityLambda'),
          CLARITY.scales.map((_, s) => clarityLevel(s, geometry)),
        );
      });
      return target;
    };
    if (needTexture) prefix.fields.texture = run(0);
    if (needClarity) prefix.fields.clarity = run(1);
  }

  /** Texture, Clarity and Dehaze, and the exposure, applied to a prefix from its cached fields. */
  function localPass(input: PipelineInput, prefix: Prefix, haze: Measured | undefined): Image {
    const { n, u, out } = input;
    const prog = P.local();
    const target = pool.acquire(prefix.region.w, prefix.region.h);
    const none = prefix.lin;
    const inputs = [
      prefix.lin,
      prefix.fields.texture ?? none,
      prefix.fields.clarity ?? none,
      haze?.densityTexture ?? none.texture,
    ];
    runner.run(prog, inputs, target, (g) => {
      ['u_lin', 'u_fieldsT', 'u_fieldsB', 'u_density'].forEach((name, unit) =>
        g.uniform1i(prog.loc(name), unit),
      );
      // Sets the exposure; it also binds the tone curve to unit 1, so bind the inputs again.
      host.applyDevelop(prog, u);
      runner.bindInputs(inputs);
      host.applyMapping(prog, out);
      g.uniform2f(prog.loc('u_tileOrigin'), prefix.region.x, prefix.region.y);
      g.uniform1f(prog.loc('u_textureStrength'), n.texture);
      g.uniform1i(prog.loc('u_clarityOn'), n.clarity ? 1 : 0);
      g.uniform1fv(
        prog.loc('u_clarityWeights'),
        n.clarity ?? new Float32Array(CLARITY.scales.length * CLARITY.knots),
      );
      g.uniform1f(prog.loc('u_key'), haze?.key ?? 0);
      g.uniform1f(prog.loc('u_dehaze'), n.dehaze);
      g.uniform1f(prog.loc('u_omega'), dehazeOmega(n.dehaze));
      const a = haze?.airlight ?? [0, 0, 0];
      g.uniform3f(prog.loc('u_airlight'), a[0], a[1], a[2]);
    });
    return target;
  }

  /** The per-pixel chain on `lin2`, then sharpening, into the final target. */
  function finish(
    input: PipelineInput,
    prefix: Prefix,
    lin2: Image,
    final: FinalTarget,
    core: Rect,
    kernel: Float32Array,
    exposed: boolean,
  ): void {
    const { n, u } = input;
    const resolve = P.resolve();
    const offset = { x: core.x - prefix.region.x, y: core.y - prefix.region.y };
    // The effects (vignette, grain) come last: here when nothing sharpens, else after the sharpening.
    const sharpening = n.sharpen !== null && kernel.length > 0;
    const resolveUniforms = (g: WebGL2RenderingContext): void => {
      host.applyDevelop(resolve, u);
      host.applyMapping(resolve, input.out);
      g.uniform1i(resolve.loc('u_lin2'), 0);
      g.uniform1f(resolve.loc('u_linGain'), exposed ? 1 : u.exposureGain);
      g.uniform1i(resolve.loc('u_effects'), sharpening ? 0 : 1);
      g.uniform2f(resolve.loc('u_tileOrigin'), prefix.region.x, prefix.region.y);
    };
    if (!sharpening) {
      runner.draw(resolve, [lin2], final.framebuffer, final.viewport, (g) => {
        resolveUniforms(g);
        placement(g, resolve, final.viewport, offset, final.flipY);
      });
      return;
    }
    const dev = pool.acquire(prefix.region.w, prefix.region.h);
    const whole = { x: 0, y: 0, w: dev.w, h: dev.h };
    runner.run(resolve, [lin2], dev, (g) => {
      resolveUniforms(g);
      placement(g, resolve, whole, { x: 0, y: 0 }, false);
    });
    const radius = (kernel.length - 1) / 2;
    const padded = new Float32Array(2 * 16 + 1);
    padded.set(kernel);
    const blur = P.blur();
    const horizontal = pool.acquire(dev.w, dev.h);
    runner.run(blur, [dev], horizontal, (g) => {
      g.uniform1i(blur.loc('u_dev'), 0);
      g.uniform1fv(blur.loc('u_kernel'), padded);
      g.uniform1i(blur.loc('u_radius'), radius);
    });
    const sharpen = P.sharpen();
    runner.draw(sharpen, [dev, horizontal], final.framebuffer, final.viewport, (g) => {
      // Sets the effects' uniforms; it also binds the tone curve to unit 1, so bind the inputs again.
      host.applyDevelop(sharpen, u);
      host.applyMapping(sharpen, input.out);
      runner.bindInputs([dev, horizontal]);
      g.uniform2f(sharpen.loc('u_tileOrigin'), prefix.region.x, prefix.region.y);
      g.uniform1i(sharpen.loc('u_dev'), 0);
      g.uniform1i(sharpen.loc('u_blurred'), 1);
      g.uniform1fv(sharpen.loc('u_kernel'), padded);
      g.uniform1i(sharpen.loc('u_radius'), radius);
      g.uniform1f(sharpen.loc('u_amount'), n.sharpen?.amount ?? 0);
      g.uniform1f(sharpen.loc('u_gain'), n.sharpen?.gain ?? 0);
      g.uniform1f(sharpen.loc('u_threshold'), n.sharpen?.threshold ?? 0);
      g.uniform1f(sharpen.loc('u_halo'), n.sharpen?.halo ?? 1);
      g.uniform1f(sharpen.loc('u_dark'), n.sharpen?.dark ?? 0);
      placement(g, sharpen, final.viewport, offset, final.flipY);
    });
    pool.release(dev);
    pool.release(horizontal);
  }

  return {
    run(input, cores, final, after) {
      const { n } = input;
      const kernel = n.sharpen
        ? gaussianKernel(n.sharpen.sigma * input.geometry.scale)
        : new Float32Array(0);
      const halo = effectiveHalo(n, input.geometry.scale);
      const wantLevels = n.texture !== 0 || n.clarity !== null;
      const wantHaze = n.clarity !== null || n.dehaze !== 0;
      const haze = wantHaze ? measure(input) : undefined;
      const single = cores.length === 1;

      const key = JSON.stringify([
        input.baseKey,
        input.geometry,
        n.luma,
        n.chroma,
        wantLevels,
        halo,
        cores,
      ]);
      let shared: { noise?: NoiseLevels; coarse?: Coarse } = {};
      let reuse: Cache | undefined;
      if (single && cache?.key === key) reuse = cache;
      else clearCache();

      if (!reuse) {
        if (hasDenoise(n) && !single) shared.noise = measureNoise(input, cores, halo);
        if (wantLevels && !single) shared.coarse = buildCoarse(input, undefined);
      } else {
        shared = { coarse: reuse.coarse };
      }

      for (const core of cores) {
        const prefix = reuse?.prefix ?? buildPrefix(input, core, halo, shared.noise, wantLevels);
        let coarse = shared.coarse;
        if (!coarse && wantLevels) coarse = buildCoarse(input, prefix);
        const useLocal = hasLocalContrast(n);
        if (useLocal) ensureFields(input, prefix, coarse);
        const lin2 = useLocal ? localPass(input, prefix, haze) : prefix.lin;
        finish(input, prefix, lin2, final(core), core, kernel, useLocal);
        if (useLocal) pool.release(lin2);
        after?.(core);
        if (single && (input.cache || reuse)) {
          // An export that found the preview's stages leaves them for the preview.
          cache = { key, prefix, coarse };
        } else {
          freePrefix(prefix);
          if (single) freeCoarse(coarse);
        }
      }
      if (!single) freeCoarse(shared.coarse);
    },

    invalidate() {
      clearCache();
      if (measured) {
        gl.deleteTexture(measured.densityTexture);
        measured = undefined;
      }
    },

    dispose() {
      clearCache();
      if (measured) gl.deleteTexture(measured.densityTexture);
      for (const p of programs.values()) gl.deleteProgram(p.program);
      pool.dispose();
      runner.dispose();
    },
  };
}
