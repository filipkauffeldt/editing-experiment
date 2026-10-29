import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { histogramOfRgba, type Histogram } from './analysis';
import { cropGeometry, cropOutputSize, isUsableCrop, type Size } from './crop';
import { DevelopGlError } from './errors';
import { FRAGMENT_SHADER } from './glsl';
import { samplesView, type LinearImageBuffer } from './image';
import { resolveUniforms, type DevelopUniforms } from './params';
import { BASE_FRAGMENT } from './neighbourhood/glsl';
import {
  hasDenoise,
  hasLocalContrast,
  needsNeighbourhood,
  resolveNeighbourhood,
  withoutNeighbourhood,
} from './neighbourhood/params';
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
import { LENS_TILE_BORDER, planSourceTiles, splitRect, type Rect, type SourceTile } from './tiling';
import { TUNING } from './tuning';
import { measuredLateralCa } from './lens/auto-ca';
import {
  CA_TERMS,
  DISTORTION_TERMS,
  VIGNETTE_DENOMINATOR_TERMS,
  VIGNETTE_NUMERATOR_TERMS,
} from './lens/model';

export { DevelopGlError };

export interface DevelopRendererOptions {
  /** Called when the GL context is lost; the image must be set again after it is restored. */
  onContextLost?: () => void;
  /** Override `MAX_TEXTURE_SIZE` (smaller values force tiling; used by tests). */
  maxTextureSize?: number;
  /** Largest tile rendered per pass by `renderToRGBA` (default 4096, bounded by GL limits). */
  maxOutputTileSize?: number;
  /**
   * Called once, the first time `render`/`renderView`/`renderToRGBA` is asked for Texture,
   * Clarity, Dehaze, sharpening or noise reduction on a context that cannot run them
   * (no `EXT_color_buffer_float`). They are then left out and everything else renders.
   */
  onNeighbourhoodUnavailable?: () => void;
  /** Pretend the GPU has no float render targets (tests of the fallback). */
  disableFloatRendering?: boolean;
  /** Stable per-photo grain seed; use {@link grainSeedFromId}. Preview and export must match. */
  grainSeed?: number;
}

/** View-only overlays; `renderToRGBA` never takes them, so exports stay clean. */
export interface DevelopViewOptions {
  /** The `J` overlay: red for clipped highlights, blue for crushed shadows. */
  clipping?: { shadows: boolean; highlights: boolean };
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
  /**
   * Uploads the image (once). `data` is the sample buffer described by `header`; the renderer
   * keeps a reference to it (no copy) for the Remove Chromatic Aberration measurement.
   */
  setImage(header: LinearImageHeader, data: LinearImageBuffer): void;
  /** Draws the image scaled to the canvas drawing buffer. Cheap enough to call on every slider tick. */
  render(params: EditParams, options?: DevelopViewOptions): void;
  /**
   * Draws the crop-mode view: the whole image, turned by `-view.crop.angle`
   * about the frame centre, with empty canvas outside the image and a dimmed
   * area outside the frame. It is the same mapping and shader as {@link render}
   * (only the transform differs), so the pixels inside the frame are the
   * committed crop's. `params.crop` is ignored. Texture, Clarity, Dehaze, sharpening
   * and noise reduction are drawn through the same pipeline (and cached stages) as
   * {@link render}.
   */
  renderView(params: EditParams, view: CropViewTransform, options?: DevelopViewOptions): void;
  /**
   * Draws `params` on the right and the unedited `before` on the left of
   * `fraction` (0..1). The before side uses the per-pixel shader without the
   * neighbourhood stages; it is a view aid, not an export.
   */
  renderSplit(
    params: EditParams,
    before: EditParams,
    fraction: number,
    options?: DevelopViewOptions,
  ): void;
  /**
   * Histogram of the frame just drawn into the canvas: a GPU downsample
   * (`blitFramebuffer`) followed by a small readback, so it does not re-render
   * the pipeline. Call it right after {@link render}, before the browser
   * composites. */
  readHistogram(bins?: number): Histogram;
  /**
   * Renders at an arbitrary size into a new 8-bit RGBA buffer (row 0 at the top),
   * through an offscreen framebuffer, in tiles when needed. Handles full resolution.
   */
  renderToRGBA(params: EditParams, size: { width: number; height: number }): Uint8Array;
  /** Resolves `params` against the current image, e.g. to show as-shot temperature/tint in the sliders. */
  resolve(params: EditParams): DevelopUniforms;
  readonly contextLost: boolean;
  /**
   * Whether Texture, Clarity, Dehaze, sharpening and noise reduction can be drawn here.
   * When false they are skipped by this renderer; a caller that must produce them (an
   * export) renders with the CPU reference instead (`renderCpu`).
   */
  readonly supportsNeighbourhood: boolean;
  /** True on SwiftShader/llvmpipe; the app skips GPU readbacks (the histogram) there unless capturing screenshots. */
  readonly softwareRendering: boolean;
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
  /** The sample buffer, kept (not copied) for the lateral CA measurement. */
  data: LinearImageBuffer;
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

const clampFraction = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

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
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName =
    debugInfo === null ? '' : String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
  const softwareRendering = /swiftshader|llvmpipe|software/i.test(rendererName);

  let res = createResources(gl);
  let source: Source | undefined;
  let lost = false;
  // Rendering to float textures is what the neighbourhood passes need; Chromium has it everywhere,
  // but a GPU or driver without it must still show the picture.
  const neighbourhoodSupported =
    options.disableFloatRendering !== true && gl.getExtension('EXT_color_buffer_float') !== null;
  let warnedUnavailable = false;
  /** Whether the uniforms last set move the sampling positions (the exact texel fetch is then wrong). */
  let lensGeometry = false;
  /** `params`, minus the neighbourhood settings when they cannot be drawn (and a single notice). */
  const drawable = (params: EditParams): EditParams => {
    if (neighbourhoodSupported || !needsNeighbourhood(params)) return params;
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      options.onNeighbourhoodUnavailable?.();
    }
    return withoutNeighbourhood(params);
  };
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

  function setUniforms(prog: GlProgram, u: DevelopUniforms, options?: DevelopViewOptions): void {
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
    gl.uniform1f(loc('u_clipShadows'), options?.clipping?.shadows ? 1 : 0);
    gl.uniform1f(loc('u_clipHighlights'), options?.clipping?.highlights ? 1 : 0);

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

    setLensUniforms(prog, u.lens);
    const fringe = (range: NonNullable<DevelopUniforms['defringe']>['purple']): number[] =>
      range ? [range.amount, range.low, range.high, range.centre] : [0, 0, 0, 0];
    gl.uniform4fv(loc('u_defringePurple'), fringe(u.defringe?.purple ?? null));
    gl.uniform4fv(loc('u_defringeGreen'), fringe(u.defringe?.green ?? null));

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

  function setLensUniforms(prog: GlProgram, lens: DevelopUniforms['lens']): void {
    const loc = (name: string): WebGLUniformLocation | null => prog.loc(name);
    lensGeometry = lens.geometry;
    gl.uniform1i(loc('u_lensGeometry'), lens.geometry ? 1 : 0);
    gl.uniform1i(loc('u_lensGain'), lens.vignette || lens.manualVignette ? 1 : 0);
    gl.uniform2f(loc('u_lensCentre'), lens.centre[0], lens.centre[1]);
    gl.uniform3f(loc('u_lensFrame'), lens.frame.x, lens.frame.y, lens.frame.radius);
    const d = lens.distortion;
    gl.uniform1i(loc('u_lensHasDist'), d ? 1 : 0);
    gl.uniform1fv(
      loc('u_lensDist'),
      d?.coefficients ?? new Array<number>(DISTORTION_TERMS).fill(0),
    );
    gl.uniform1f(loc('u_lensDistUnit'), d?.unit ?? 1);
    gl.uniform1f(loc('u_lensManual'), lens.manualDistortion);
    const ca = lens.ca;
    gl.uniform1i(loc('u_lensHasCa'), ca ? 1 : 0);
    gl.uniform1fv(loc('u_lensRed'), ca?.red ?? new Array<number>(CA_TERMS).fill(0));
    gl.uniform1fv(loc('u_lensBlue'), ca?.blue ?? new Array<number>(CA_TERMS).fill(0));
    gl.uniform1f(loc('u_lensCaUnit'), ca?.unit ?? 1);
    gl.uniform1i(loc('u_lensCaAtSource'), ca?.atSource ? 1 : 0);
    const v = lens.vignette;
    gl.uniform1i(loc('u_lensHasVig'), v ? 1 : 0);
    gl.uniform1fv(
      loc('u_lensVigNum'),
      v?.numerator ?? new Array<number>(VIGNETTE_NUMERATOR_TERMS).fill(0),
    );
    gl.uniform1fv(
      loc('u_lensVigDen'),
      v?.denominator ?? new Array<number>(VIGNETTE_DENOMINATOR_TERMS).fill(1),
    );
    gl.uniform1f(loc('u_lensVigUnit'), v?.unit ?? 1);
    gl.uniform1f(loc('u_lensVigExp'), v?.exponent ?? 1);
    const m = lens.manualVignette;
    gl.uniform1i(loc('u_lensHasManualVig'), m ? 1 : 0);
    gl.uniform4f(
      loc('u_lensManualVig'),
      m?.amount ?? 0,
      m?.scale ?? 0,
      m?.power ?? 1,
      m?.knee ?? 0,
    );
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

  /** The crop view's uniforms on `prog`; `undefined` switches the view mode off (the normal render). */
  function setViewUniformsOn(prog: GlProgram, view: CropViewTransform | undefined): void {
    const loc = (name: string): WebGLUniformLocation | null => prog.loc(name);
    gl.useProgram(prog.program);
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

  /** The same on the single develop pass. */
  function setViewUniforms(view: CropViewTransform | undefined): void {
    setViewUniformsOn(res.direct, view);
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
        !lensGeometry &&
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
  let frame:
    | {
        src: Source;
        mapping: Mapping;
        u: DevelopUniforms;
        view?: CropViewTransform;
        options?: DevelopViewOptions;
      }
    | undefined;
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
      setUniforms(prog, { ...u, exposureGain: 1 }, frame.options);
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
      setUniforms(program, u, frame?.options);
    },
    applyView(program) {
      setViewUniformsOn(program, frame?.view);
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
    // Output pixels per source pixel: the crop view (a different transform) has its own scale.
    const perHeader = 1 / mapping.outScale.x;
    return {
      n: resolveNeighbourhood(params),
      u,
      out,
      sourceSize: { width: header.width, height: header.height },
      geometry: {
        scale: perHeader * (header.width / (header.sourceWidth || header.width)),
        fullLongEdge: Math.max(header.width, header.height) * perHeader,
      },
      baseKey: `${imageId}|${JSON.stringify([
        out,
        [mapping.center, mapping.cos, mapping.sin, mapping.outScale, mapping.outCenter],
        u.multipliers,
        u.colorMatrix,
        u.calibration,
        u.lens,
      ])}`,
      cache,
    };
  }

  /** Resolves `params` for `src`, measuring the lateral CA the first time it is asked for. */
  function uniformsFor(src: Source, params: EditParams): DevelopUniforms {
    return resolveUniforms(src.header, params, {
      grainSeed: options.grainSeed,
      measuredCa: params.AutoLateralCA === true ? measuredLateralCa(src.header, src.data) : null,
    });
  }

  const usesNeighbourhood = (input: PipelineInput): boolean =>
    hasDenoise(input.n) || hasLocalContrast(input.n) || input.n.sharpen !== null;

  /** Draws the normal (cropped) view. Split view also uses this for its right side. */
  function drawDevelop(requested: EditParams, viewOptions?: DevelopViewOptions): void {
    const params = drawable(requested);
    const src = requireSource();
    const out = { width: canvas.width, height: canvas.height };
    const mapping = mappingFor(src.header, params, cropLogicalSize(src.header, params), out);
    const u = uniformsFor(src, params);
    const input = pipelineInput(src, params, mapping, u, out, true);
    if (usesNeighbourhood(input)) {
      frame = { src, mapping, u, options: viewOptions };
      const cores = planCores(out, maxOutputTile, effectiveHalo(input.n, input.geometry.scale));
      getPipeline().run(input, cores, (core) => ({
        framebuffer: null,
        viewport: { x: core.x, y: out.height - core.y - core.h, w: core.w, h: core.h },
        flipY: true,
      }));
      return;
    }
    setUniforms(res.direct, u, viewOptions);
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
  }

  /** Draws the crop-mode view (the whole image under the frame). */
  function drawCropView(
    requested: EditParams,
    view: CropViewTransform,
    viewOptions?: DevelopViewOptions,
  ): void {
    const params = drawable(requested);
    const src = requireSource();
    const out = { width: canvas.width, height: canvas.height };
    const mapping = viewMapping(src.header, view, out);
    const u = uniformsFor(src, params);
    const input = pipelineInput(src, params, mapping, u, out, true);
    if (usesNeighbourhood(input)) {
      // The same pipeline and cached stages as the normal view; only the mapping and the
      // last step (empty canvas, dimmed outside the frame) differ.
      frame = { src, mapping, u, view, options: viewOptions };
      const cores = planCores(out, maxOutputTile, effectiveHalo(input.n, input.geometry.scale));
      getPipeline().run(input, cores, (core) => ({
        framebuffer: null,
        viewport: { x: core.x, y: out.height - core.y - core.h, w: core.w, h: core.h },
        flipY: true,
      }));
      return;
    }
    setUniforms(res.direct, u, viewOptions);
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
  }

  /** The before side of a split view: the whole frame (or the committed crop), drawn directly. */
  function drawBefore(
    before: EditParams,
    fraction: number,
    viewOptions?: DevelopViewOptions,
  ): void {
    const src = requireSource();
    const out = { width: canvas.width, height: canvas.height };
    const width = Math.round(clampFraction(fraction) * out.width);
    if (width <= 0) return;
    const params = drawable(before);
    const mapping = mappingFor(src.header, params, cropLogicalSize(src.header, params), out);
    const u = uniformsFor(src, params);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, width, out.height);
    setUniforms(res.direct, u, viewOptions);
    setViewUniforms(undefined);
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
    gl.disable(gl.SCISSOR_TEST);
  }

  let histogramTarget:
    | { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number }
    | undefined;

  function dropHistogramTarget(): void {
    if (!histogramTarget) return;
    gl.deleteFramebuffer(histogramTarget.framebuffer);
    gl.deleteTexture(histogramTarget.texture);
    histogramTarget = undefined;
  }

  function histogramTargetOf(width: number, height: number): NonNullable<typeof histogramTarget> {
    if (histogramTarget?.width === width && histogramTarget.height === height)
      return histogramTarget;
    dropHistogramTarget();
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new DevelopGlError('Could not create histogram target');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      throw new DevelopGlError(`Histogram framebuffer of ${width}x${height} is incomplete`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    histogramTarget = { framebuffer, texture, width, height };
    return histogramTarget;
  }

  return {
    get contextLost() {
      return lost;
    },

    get supportsNeighbourhood() {
      return neighbourhoodSupported;
    },

    get softwareRendering() {
      return softwareRendering;
    },

    setImage(header, data) {
      if (disposed) throw new DevelopGlError('Renderer is disposed');
      if (lost) throw new DevelopGlError('WebGL context lost');
      const view = samplesView(header, data);
      freeSource();
      pipeline?.invalidate();
      imageId++;
      const tiles = planSourceTiles(header.width, header.height, maxTexture, LENS_TILE_BORDER).map(
        (tile) => ({
          tile,
          texture: uploadTile(header, view, tile),
        }),
      );
      source = { header, data, tiles };
    },

    resolve(params) {
      return uniformsFor(requireSource(), params);
    },

    render(requested, viewOptions) {
      drawDevelop(requested, viewOptions);
    },

    renderView(requested, view, viewOptions) {
      drawCropView(requested, view, viewOptions);
    },

    renderSplit(requested, before, fraction, viewOptions) {
      drawDevelop(requested, viewOptions);
      drawBefore(before, fraction, viewOptions);
    },

    readHistogram(bins = 256) {
      const width = canvas.width;
      const height = canvas.height;
      if (!(width > 0 && height > 0)) {
        throw new DevelopGlError('Nothing to measure: the canvas has no pixels');
      }
      const scale = Math.min(1, 256 / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const target = histogramTargetOf(targetWidth, targetHeight);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
      gl.blitFramebuffer(
        0,
        0,
        width,
        height,
        0,
        0,
        targetWidth,
        targetHeight,
        gl.COLOR_BUFFER_BIT,
        gl.LINEAR,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) {
        throw new DevelopGlError(`WebGL error 0x${error.toString(16)} while reading the histogram`);
      }
      const pixels = new Uint8Array(targetWidth * targetHeight * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
      gl.readPixels(0, 0, targetWidth, targetHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      return histogramOfRgba(pixels, targetWidth, targetHeight, bins);
    },

    renderToRGBA(requested, size) {
      const params = drawable(requested);
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
      const u = uniformsFor(src, params);
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
        dropHistogramTarget();
        gl.deleteTexture(res.curveTexture);
        gl.deleteProgram(res.direct.program);
        gl.deleteProgram(res.base.program);
      }
    },
  };
}
