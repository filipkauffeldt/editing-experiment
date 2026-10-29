import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { cropGeometry, cropOutputSize, isUsableCrop, type Size } from './crop';
import { DevelopGlError } from './errors';
import { FRAGMENT_SHADER } from './glsl';
import { samplesView, type LinearImageBuffer } from './image';
import { resolveUniforms, type DevelopUniforms } from './params';
import { BASE_FRAGMENT } from './neighbourhood/glsl';
import { hasDenoise, hasLocalContrast, resolveNeighbourhood } from './neighbourhood/params';
import { createProgram, type GlProgram } from './neighbourhood/passes';
import {
  createNeighbourhoodPipeline,
  effectiveHalo,
  planCores,
  type BaseOptions,
  type FinalTarget,
  type NeighbourhoodPipeline,
  type PipelineHost,
  type PipelineInput,
} from './neighbourhood/pipeline';
import { planSourceTiles, splitRect, type Rect, type SourceTile } from './tiling';
import { TUNING } from './tuning';

export { DevelopGlError };

export interface DevelopRendererOptions {
  /** Called when the GL context is lost; the image must be set again after it is restored. */
  onContextLost?: () => void;
  /** Override `MAX_TEXTURE_SIZE` (smaller values force tiling; used by tests). */
  maxTextureSize?: number;
  /** Largest tile rendered per pass by `renderToRGBA` (default 4096, bounded by GL limits). */
  maxOutputTileSize?: number;
  /** Stable per-photo grain seed; use {@link grainSeedFromId}. Preview and export must match. */
  grainSeed?: number;
}

/** Where the crop-mode view puts the image on the canvas, in drawing-buffer pixels. */
export interface CropViewTransform {
  /** The crop being edited (`EditParams.crop` units): gives the pivot in the source and the angle. */
  crop: NonNullable<EditParams['crop']>;
  /** Drawing-buffer position (origin top-left) of the crop centre, i.e. of the frame centre. */
  pivot: { x: number; y: number };
  /** Drawing-buffer pixels per pixel of the *uploaded* image. */
  scale: number;
  /** The crop frame in drawing-buffer pixels; outside it the image is dimmed. */
  frame: { x: number; y: number; w: number; h: number };
  /** Gain applied outside the frame, 0..1. */
  dim: number;
  /** sRGB colour (0..1) of the empty canvas outside the image. */
  outside: [number, number, number];
}

export interface DevelopRenderer {
  /** Uploads the image (once). `data` is the sample buffer described by `header`; it is not retained. */
  setImage(header: LinearImageHeader, data: LinearImageBuffer): void;
  /** Draws the image scaled to the canvas drawing buffer. Cheap enough to call on every slider tick. */
  render(params: EditParams): void;
  /**
   * Draws the crop-mode view: the whole image, turned by `-view.crop.angle`
   * about the frame centre, with empty canvas outside the image and a dimmed
   * area outside the frame. It is the same mapping and shader as {@link render}
   * (only the transform differs), so the pixels inside the frame are the
   * committed crop's. `params.crop` is ignored. Texture, Clarity, Dehaze, sharpening
   * and noise reduction are not drawn in this view (it uses the single develop pass).
   */
  renderView(params: EditParams, view: CropViewTransform): void;
  /**
   * Renders at an arbitrary size into a new 8-bit RGBA buffer (row 0 at the top),
   * through an offscreen framebuffer, in tiles when needed. Handles full resolution.
   */
  renderToRGBA(params: EditParams, size: { width: number; height: number }): Uint8Array;
  /** Resolves `params` against the current image, e.g. to show as-shot temperature/tint in the sliders. */
  resolve(params: EditParams): DevelopUniforms;
  readonly contextLost: boolean;
  dispose(): void;
}

type Canvas = HTMLCanvasElement | OffscreenCanvas;

interface Resources {
  /** Source fetch and the whole per-pixel chain in one pass (no neighbourhood ops). */
  direct: GlProgram;
  /** Source fetch, white balance and exposure only; the neighbourhood pipeline runs the rest. */
  base: GlProgram;
  curveTexture: WebGLTexture;
  uploadedCurve: Float32Array | null | undefined;
}

interface Source {
  header: LinearImageHeader;
  tiles: { tile: SourceTile; texture: WebGLTexture }[];
}

/** How output pixels map to the source: crop centre + clockwise straighten angle. */
interface Mapping {
  /** Crop centre in source pixels; the rotation pivot. */
  center: { x: number; y: number };
  cos: number;
  sin: number;
  /** Logical output size in pixels (the crop's size, not the preview buffer's). */
  logical: Size;
  /** Source pixels per buffer pixel, per axis. */
  outScale: { x: number; y: number };
  /** The logical output position that sits at the rotation pivot. */
  outCenter: { x: number; y: number };
  /** True when the output is the source pixel-for-pixel (no crop, no scaling). */
  identity: boolean;
}

function mappingFor(
  header: LinearImageHeader,
  params: EditParams,
  logical: Size,
  buffer: Size,
): Mapping {
  const image = { width: header.width, height: header.height };
  const crop = params.crop;
  if (!crop || !isUsableCrop(crop)) {
    return {
      center: { x: image.width / 2, y: image.height / 2 },
      cos: 1,
      sin: 0,
      logical,
      outScale: { x: logical.width / buffer.width, y: logical.height / buffer.height },
      outCenter: { x: logical.width / 2, y: logical.height / 2 },
      identity: logical.width === image.width && logical.height === image.height,
    };
  }
  const geometry = cropGeometry(crop, image);
  const radians = (geometry.angle * Math.PI) / 180;
  return {
    center: { x: geometry.centerX, y: geometry.centerY },
    cos: Math.cos(radians),
    sin: Math.sin(radians),
    logical,
    outScale: { x: logical.width / buffer.width, y: logical.height / buffer.height },
    outCenter: { x: logical.width / 2, y: logical.height / 2 },
    identity: false,
  };
}

/** The crop-mode view as a mapping: buffer pixels about the pivot -> source pixels about the crop centre. */
function viewMapping(header: LinearImageHeader, view: CropViewTransform, buffer: Size): Mapping {
  const geometry = cropGeometry(view.crop, { width: header.width, height: header.height });
  const radians = (geometry.angle * Math.PI) / 180;
  const perBuffer = 1 / view.scale;
  return {
    center: { x: geometry.centerX, y: geometry.centerY },
    cos: Math.cos(radians),
    sin: Math.sin(radians),
    // Unused by the view mapping, which sets the scale and pivot directly.
    logical: buffer,
    outScale: { x: perBuffer, y: perBuffer },
    outCenter: { x: view.pivot.x * perBuffer, y: view.pivot.y * perBuffer },
    identity: false,
  };
}

function cropLogicalSize(header: LinearImageHeader, params: EditParams): Size {
  const image = { width: header.width, height: header.height };
  const crop = params.crop;
  if (crop && isUsableCrop(crop)) {
    const size = cropOutputSize(crop, image);
    return {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    };
  }
  return image;
}

function createResources(gl: WebGL2RenderingContext): Resources {
  const direct = createProgram(gl, FRAGMENT_SHADER);
  const base = createProgram(gl, BASE_FRAGMENT);

  const curveTexture = gl.createTexture();
  if (!curveTexture) throw new DevelopGlError('Could not create texture');
  gl.bindTexture(gl.TEXTURE_2D, curveTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Placeholder so the sampler is always complete; replaced when a curve is used.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    TUNING.curveLutSize,
    1,
    0,
    gl.RGBA,
    gl.FLOAT,
    new Float32Array(TUNING.curveLutSize * 4),
  );
  return { direct, base, curveTexture, uploadedCurve: null };
}

/** Row-major 3x3 to the column-major order `uniformMatrix3fv` expects, so `u_color * v` is `M v`. */
const toColumnMajor = (m: readonly number[]): Float32Array =>
  new Float32Array([
    m[0] ?? 0,
    m[3] ?? 0,
    m[6] ?? 0,
    m[1] ?? 0,
    m[4] ?? 0,
    m[7] ?? 0,
    m[2] ?? 0,
    m[5] ?? 0,
    m[8] ?? 0,
  ]);

export function createDevelopRenderer(
  canvas: Canvas,
  options: DevelopRendererOptions = {},
): DevelopRenderer {
  const context = (canvas as HTMLCanvasElement).getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (!context) throw new DevelopGlError('WebGL2 is not available');
  const gl: WebGL2RenderingContext = context;

  let res = createResources(gl);
  let source: Source | undefined;
  let lost = false;
  let disposed = false;

  const maxTexture = Math.min(
    options.maxTextureSize ?? Infinity,
    gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
  );
  const viewportMax = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  const maxOutputTile = Math.min(
    options.maxOutputTileSize ?? 4096,
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    maxTexture,
    viewportMax[0] ?? 4096,
    viewportMax[1] ?? 4096,
  );

  const onLost = (event: Event): void => {
    event.preventDefault();
    lost = true;
    source = undefined;
    options.onContextLost?.();
  };
  const onRestored = (): void => {
    pipeline = undefined;
    res = createResources(gl);
    lost = false;
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const freeSource = (): void => {
    if (!source) return;
    for (const { texture } of source.tiles) gl.deleteTexture(texture);
    source = undefined;
  };

  function uploadTile(
    header: LinearImageHeader,
    view: Uint16Array | Float32Array,
    tile: SourceTile,
  ): WebGLTexture {
    const texture = gl.createTexture();
    if (!texture) throw new DevelopGlError('Could not create texture');
    const { x, y, w, h } = tile.texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Read the tile straight out of the full-image buffer; no per-tile copy.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, header.width);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      w,
      h,
      0,
      gl.RGBA,
      header.sampleType === 'f16' ? gl.HALF_FLOAT : gl.FLOAT,
      view,
    );
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return texture;
  }

  function setUniforms(prog: GlProgram, u: DevelopUniforms): void {
    const loc = (name: string): WebGLUniformLocation | null => prog.loc(name);
    gl.useProgram(prog.program);
    gl.uniform1i(loc('u_image'), 0);
    gl.uniform1i(loc('u_curve'), 1);
    gl.uniform3fv(loc('u_wb'), u.multipliers);
    gl.uniformMatrix3fv(loc('u_color'), false, toColumnMajor(u.colorMatrix));
    gl.uniform1f(loc('u_exposure'), u.exposureGain);
    gl.uniform1i(loc('u_toneActive'), u.toneActive ? 1 : 0);
    gl.uniform1f(loc('u_contrastGamma'), u.tone.contrastGamma);
    gl.uniform1f(loc('u_highlights'), u.tone.highlights);
    gl.uniform1f(loc('u_shadows'), u.tone.shadows);
    gl.uniform1f(loc('u_whites'), u.tone.whites);
    gl.uniform1f(loc('u_blacks'), u.tone.blacks);
    gl.uniform1i(loc('u_hasCurve'), u.curveLut ? 1 : 0);
    gl.uniform1f(loc('u_vibrance'), u.vibrance);
    gl.uniform1f(loc('u_saturation'), u.saturation);

    gl.uniformMatrix3fv(loc('u_calibration'), false, toColumnMajor(u.calibration.matrix));
    gl.uniform1f(loc('u_shadowTint'), u.calibration.shadow);
    gl.uniform1i(loc('u_mixerActive'), u.mixer.active ? 1 : 0);
    gl.uniform1fv(
      loc('u_hslHue'),
      u.mixer.bands.map((band) => band.hue),
    );
    gl.uniform1fv(
      loc('u_hslSat'),
      u.mixer.bands.map((band) => band.sat),
    );
    gl.uniform1fv(
      loc('u_hslLum'),
      u.mixer.bands.map((band) => band.lum),
    );
    gl.uniform1i(loc('u_gradingActive'), u.grading.active ? 1 : 0);
    const grade = (region: { hue: number; sat: number; lum: number }): number[] => [
      region.hue,
      region.sat,
      region.lum,
      0,
    ];
    gl.uniform4fv(loc('u_gradeShadow'), grade(u.grading.shadows));
    gl.uniform4fv(loc('u_gradeMidtone'), grade(u.grading.midtones));
    gl.uniform4fv(loc('u_gradeHighlight'), grade(u.grading.highlights));
    gl.uniform4fv(loc('u_gradeGlobal'), grade(u.grading.global));
    gl.uniform1f(loc('u_gradeBlending'), u.grading.blending);
    gl.uniform1f(loc('u_gradeBalance'), u.grading.balance);
    const vignette = u.vignette;
    gl.uniform1f(loc('u_vignetteAmount'), vignette?.amount ?? 0);
    gl.uniform1i(
      loc('u_vignetteStyle'),
      vignette?.style === 'Color Priority' ? 2 : vignette?.style === 'Paint Overlay' ? 3 : 0,
    );
    gl.uniform1f(loc('u_vignetteHighlights'), vignette?.highlights ?? 0);
    gl.uniform2f(loc('u_vignetteScale'), vignette?.scaleX ?? 1, vignette?.scaleY ?? 1);
    gl.uniform1f(loc('u_vignettePower'), vignette?.power ?? 2);
    gl.uniform1f(loc('u_vignetteMidpoint'), vignette?.midpoint ?? 0);
    gl.uniform1f(loc('u_vignetteFeather'), vignette?.feather ?? 0.5);
    gl.uniform1f(loc('u_grainAmount'), u.grain?.amount ?? 0);
    gl.uniform1f(loc('u_grainCell'), u.grain?.cell ?? 1);
    gl.uniform1f(loc('u_grainCoarse'), u.grain?.coarse ?? 0);
    gl.uniform1f(loc('u_grainFine'), u.grain?.fine ?? 0);
    gl.uniform1ui(loc('u_grainSeed'), (u.grain?.seed ?? 0) >>> 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, res.curveTexture);
    if (u.curveLut && res.uploadedCurve !== u.curveLut) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        TUNING.curveLutSize,
        1,
        0,
        gl.RGBA,
        gl.FLOAT,
        u.curveLut,
      );
      res.uploadedCurve = u.curveLut;
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Sets the output -> source mapping uniforms (everything but the tile's own source texture). */
  function setMapping(prog: GlProgram, src: Source, buffer: Size, mapping: Mapping): void {
    const loc = (name: string): WebGLUniformLocation | null => prog.loc(name);
    gl.uniform2f(loc('u_outSize'), buffer.width, buffer.height);
    gl.uniform2f(loc('u_outScale'), mapping.outScale.x, mapping.outScale.y);
    gl.uniform2f(loc('u_outCenter'), mapping.outCenter.x, mapping.outCenter.y);
    gl.uniform2f(loc('u_srcCenter'), mapping.center.x, mapping.center.y);
    gl.uniform2f(loc('u_srcRot'), mapping.cos, mapping.sin);
    gl.uniform2f(loc('u_srcSize'), src.header.width, src.header.height);
  }

  /** The crop view's uniforms on the develop pass; `undefined` switches the view mode off (the normal render). */
  function setViewUniforms(view: CropViewTransform | undefined): void {
    const loc = (name: string): WebGLUniformLocation | null => res.direct.loc(name);
    gl.useProgram(res.direct.program);
    gl.uniform1i(loc('u_viewMode'), view ? 1 : 0);
    gl.uniform4f(
      loc('u_frame'),
      view?.frame.x ?? 0,
      view?.frame.y ?? 0,
      (view?.frame.x ?? 0) + (view?.frame.w ?? 0),
      (view?.frame.y ?? 0) + (view?.frame.h ?? 0),
    );
    gl.uniform1f(loc('u_dim'), view?.dim ?? 1);
    gl.uniform3f(loc('u_outside'), ...(view?.outside ?? [0, 0, 0]));
  }

  /**
   * Draws the viewport from one source tile. Fragments whose source sample is
   * not inside the tile's core are discarded, so the tiles partition the output
   * even when rotation makes their output regions non-rectangular (and overlap).
   */
  function drawTile(
    prog: GlProgram,
    src: Source,
    entry: Source['tiles'][number],
    buffer: Size,
    mapping: Mapping,
    viewport: Rect,
    tileOrigin: { x: number; y: number },
    flipY: boolean,
    allowNearest = true,
  ): void {
    const loc = (name: string): WebGLUniformLocation | null => prog.loc(name);
    const t = entry.tile.texture;
    const core = entry.tile.core;
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    setMapping(prog, src, buffer, mapping);
    gl.uniform2f(loc('u_tileOrigin'), tileOrigin.x, tileOrigin.y);
    gl.uniform2f(loc('u_srcOrigin'), t.x, t.y);
    gl.uniform2f(loc('u_srcTexSize'), t.w, t.h);
    gl.uniform2f(loc('u_coreMin'), core.x, core.y);
    gl.uniform2f(loc('u_coreMax'), core.x + core.w, core.y + core.h);
    gl.uniform1f(loc('u_flipY'), flipY ? 1 : 0);
    gl.uniform1i(
      loc('u_nearest'),
      allowNearest &&
        mapping.identity &&
        mapping.logical.width === buffer.width &&
        mapping.logical.height === buffer.height
        ? 1
        : 0,
    );
    gl.viewport(viewport.x, viewport.y, viewport.w, viewport.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function requireSource(): Source {
    if (disposed) throw new DevelopGlError('Renderer is disposed');
    if (lost)
      throw new DevelopGlError('WebGL context lost; call setImage again after it is restored');
    if (!source) throw new DevelopGlError('No image: call setImage first');
    return source;
  }

  /** What the neighbourhood pipeline needs of the current frame. */
  let frame: { src: Source; mapping: Mapping; u: DevelopUniforms } | undefined;
  let imageId = 0;
  let pipeline: NeighbourhoodPipeline | undefined;

  const identityMapping = (header: LinearImageHeader, buffer: Size): Mapping => ({
    center: { x: header.width / 2, y: header.height / 2 },
    cos: 1,
    sin: 0,
    logical: { width: header.width, height: header.height },
    outScale: { x: header.width / buffer.width, y: header.height / buffer.height },
    outCenter: { x: header.width / 2, y: header.height / 2 },
    identity: true,
  });

  const host: PipelineHost = {
    drawBase(runner, target, region, o: BaseOptions) {
      if (!frame) throw new DevelopGlError('No frame');
      const { src, mapping, u } = frame;
      const prog = res.base;
      // The pipeline works at Exposure 0 and applies the exposure after its cached stages.
      setUniforms(prog, { ...u, exposureGain: 1 });
      gl.uniform1i(prog.loc('u_taps'), o.taps);
      gl.uniform1f(prog.loc('u_posScale'), o.posScale);
      gl.uniform2f(prog.loc('u_posMax'), o.posMax[0], o.posMax[1]);
      runner.bindTarget(target);
      const used = o.measure ? identityMapping(src.header, o.buffer) : mapping;
      for (const entry of src.tiles) {
        drawTile(
          prog,
          src,
          entry,
          o.buffer,
          used,
          { x: 0, y: 0, w: region.w, h: region.h },
          { x: region.x, y: region.y },
          false,
          o.taps === 1,
        );
      }
    },
    applyDevelop(program, u) {
      setUniforms(program, u);
    },
    applyMapping(program, out) {
      if (!frame) throw new DevelopGlError('No frame');
      setMapping(program, frame.src, out, frame.mapping);
    },
  };

  function getPipeline(): NeighbourhoodPipeline {
    pipeline ??= createNeighbourhoodPipeline(gl, host);
    return pipeline;
  }

  /** Everything the pipeline needs to know about this render. */
  function pipelineInput(
    src: Source,
    params: EditParams,
    mapping: Mapping,
    u: DevelopUniforms,
    out: Size,
    cache: boolean,
  ): PipelineInput {
    const header = src.header;
    const perHeader = out.width / mapping.logical.width;
    return {
      n: resolveNeighbourhood(params),
      u,
      out,
      sourceSize: { width: header.width, height: header.height },
      geometry: {
        scale: perHeader * (header.width / (header.sourceWidth || header.width)),
        fullLongEdge: Math.max(header.width, header.height) * perHeader,
      },
      baseKey: `${imageId}|${JSON.stringify([out, params.crop, u.multipliers, u.colorMatrix, u.calibration])}`,
      cache,
    };
  }

  const usesNeighbourhood = (input: PipelineInput): boolean =>
    hasDenoise(input.n) || hasLocalContrast(input.n) || input.n.sharpen !== null;

  return {
    get contextLost() {
      return lost;
    },

    setImage(header, data) {
      if (disposed) throw new DevelopGlError('Renderer is disposed');
      if (lost) throw new DevelopGlError('WebGL context lost');
      const view = samplesView(header, data);
      freeSource();
      pipeline?.invalidate();
      imageId++;
      const tiles = planSourceTiles(header.width, header.height, maxTexture).map((tile) => ({
        tile,
        texture: uploadTile(header, view, tile),
      }));
      source = { header, tiles };
    },

    resolve(params) {
      return resolveUniforms(requireSource().header, params, { grainSeed: options.grainSeed });
    },

    render(params) {
      const src = requireSource();
      const out = { width: canvas.width, height: canvas.height };
      const mapping = mappingFor(src.header, params, cropLogicalSize(src.header, params), out);
      const u = resolveUniforms(src.header, params, { grainSeed: options.grainSeed });
      const input = pipelineInput(src, params, mapping, u, out, true);
      if (usesNeighbourhood(input)) {
        frame = { src, mapping, u };
        const cores = planCores(out, maxOutputTile, effectiveHalo(input.n, input.geometry.scale));
        getPipeline().run(input, cores, (core) => ({
          framebuffer: null,
          viewport: { x: core.x, y: out.height - core.y - core.h, w: core.w, h: core.h },
          flipY: true,
        }));
        return;
      }
      setUniforms(res.direct, u);
      setViewUniforms(undefined);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const entry of src.tiles) {
        drawTile(
          res.direct,
          src,
          entry,
          out,
          mapping,
          { x: 0, y: 0, w: out.width, h: out.height },
          { x: 0, y: 0 },
          true,
        );
      }
    },

    renderView(params, view) {
      const src = requireSource();
      const out = { width: canvas.width, height: canvas.height };
      const mapping = viewMapping(src.header, view, out);
      setUniforms(
        res.direct,
        resolveUniforms(src.header, params, { grainSeed: options.grainSeed }),
      );
      setViewUniforms(view);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const entry of src.tiles) {
        drawTile(
          res.direct,
          src,
          entry,
          out,
          mapping,
          { x: 0, y: 0, w: out.width, h: out.height },
          { x: 0, y: 0 },
          true,
        );
      }
      setViewUniforms(undefined);
    },

    renderToRGBA(params, size) {
      const src = requireSource();
      const width = Math.round(size.width);
      const height = Math.round(size.height);
      if (!(width > 0 && height > 0))
        throw new RangeError(`Invalid render size ${size.width}x${size.height}`);
      const result = new Uint8Array(width * height * 4);
      const out = { width, height };
      // `size` is the render-target buffer; the logical space is the crop (or
      // the full image), so other sizes resample it like the old pipeline did.
      const mapping = mappingFor(src.header, params, cropLogicalSize(src.header, params), out);
      const u = resolveUniforms(src.header, params, { grainSeed: options.grainSeed });
      const input = pipelineInput(src, params, mapping, u, out, false);
      const neighbourhood = usesNeighbourhood(input);

      const cores = neighbourhood
        ? planCores(out, maxOutputTile, effectiveHalo(input.n, input.geometry.scale))
        : splitRect({ x: 0, y: 0, w: width, h: height }, maxOutputTile);
      const tileW = Math.min(width, Math.max(...cores.map((c) => c.w)));
      const tileH = Math.min(height, Math.max(...cores.map((c) => c.h)));
      const framebuffer = gl.createFramebuffer();
      const renderbuffer = gl.createRenderbuffer();
      if (!framebuffer || !renderbuffer) throw new DevelopGlError('Could not create framebuffer');
      try {
        gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, tileW, tileH);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.RENDERBUFFER,
          renderbuffer,
        );
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new DevelopGlError(`Offscreen framebuffer of ${tileW}x${tileH} is incomplete`);
        }
        const scratch = new Uint8Array(tileW * tileH * 4);
        const store = (rect: Rect): void => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          // Rows come back bottom-up from the framebuffer, which the shader already compensates for.
          gl.readPixels(0, 0, rect.w, rect.h, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
          for (let row = 0; row < rect.h; row++) {
            const from = row * rect.w * 4;
            result.set(
              scratch.subarray(from, from + rect.w * 4),
              ((rect.y + row) * width + rect.x) * 4,
            );
          }
        };
        if (neighbourhood) {
          frame = { src, mapping, u };
          const target = (core: Rect): FinalTarget => ({
            framebuffer,
            viewport: { x: 0, y: 0, w: core.w, h: core.h },
            flipY: false,
          });
          getPipeline().run(input, cores, target, store);
        } else {
          setUniforms(res.direct, u);
          setViewUniforms(undefined);
          for (const rect of cores) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            for (const entry of src.tiles) {
              drawTile(
                res.direct,
                src,
                entry,
                out,
                mapping,
                { x: 0, y: 0, w: rect.w, h: rect.h },
                { x: rect.x, y: rect.y },
                false,
              );
            }
            store(rect);
          }
        }
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteRenderbuffer(renderbuffer);
      }
      const error = gl.getError();
      if (error !== gl.NO_ERROR)
        throw new DevelopGlError(`WebGL error 0x${error.toString(16)} while rendering`);
      return result;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (!lost) {
        freeSource();
        pipeline?.dispose();
        gl.deleteTexture(res.curveTexture);
        gl.deleteProgram(res.direct.program);
        gl.deleteProgram(res.base.program);
      }
    },
  };
}
