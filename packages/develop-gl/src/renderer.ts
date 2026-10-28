import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { cropGeometry, cropOutputSize, type Size } from './crop';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './glsl';
import { samplesView, type LinearImageBuffer } from './image';
import { resolveUniforms, type DevelopUniforms } from './params';
import { planSourceTiles, splitRect, type Rect, type SourceTile } from './tiling';
import { TUNING } from './tuning';

/** Thrown when WebGL2 is unavailable or a GL resource cannot be created. */
export class DevelopGlError extends Error {
  override readonly name = 'DevelopGlError';
}

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

export interface DevelopRenderer {
  /** Uploads the image (once). `data` is the sample buffer described by `header`; it is not retained. */
  setImage(header: LinearImageHeader, data: LinearImageBuffer): void;
  /** Draws the image scaled to the canvas drawing buffer. Cheap enough to call on every slider tick. */
  render(params: EditParams): void;
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

const UNIFORMS = [
  'u_image',
  'u_curve',
  'u_wb',
  'u_color',
  'u_exposure',
  'u_toneActive',
  'u_contrastGamma',
  'u_highlights',
  'u_shadows',
  'u_whites',
  'u_blacks',
  'u_hasCurve',
  'u_vibrance',
  'u_saturation',
  'u_calibration',
  'u_shadowTint',
  'u_mixerActive',
  'u_hslHue',
  'u_hslSat',
  'u_hslLum',
  'u_gradingActive',
  'u_gradeShadow',
  'u_gradeMidtone',
  'u_gradeHighlight',
  'u_gradeGlobal',
  'u_gradeBlending',
  'u_gradeBalance',
  'u_vignetteAmount',
  'u_vignetteStyle',
  'u_vignetteHighlights',
  'u_vignetteScale',
  'u_vignettePower',
  'u_vignetteMidpoint',
  'u_vignetteFeather',
  'u_grainAmount',
  'u_grainCell',
  'u_grainCoarse',
  'u_grainFine',
  'u_grainSeed',
  'u_outSize',
  'u_outScale',
  'u_outCenter',
  'u_tileOrigin',
  'u_srcCenter',
  'u_srcRot',
  'u_srcOrigin',
  'u_srcTexSize',
  'u_srcSize',
  'u_coreMin',
  'u_coreMax',
  'u_flipY',
  'u_nearest',
] as const;
type UniformName = (typeof UNIFORMS)[number];

interface Resources {
  program: WebGLProgram;
  uniforms: Record<UniformName, WebGLUniformLocation | null>;
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
  /** True when the output is the source pixel-for-pixel (no crop, no scaling). */
  identity: boolean;
}

function mappingFor(header: LinearImageHeader, params: EditParams, logical: Size): Mapping {
  const image = { width: header.width, height: header.height };
  const crop = params.crop;
  if (
    !crop ||
    !Number.isFinite(crop.left) ||
    !Number.isFinite(crop.top) ||
    !Number.isFinite(crop.right) ||
    !Number.isFinite(crop.bottom) ||
    !(crop.right > crop.left) ||
    !(crop.bottom > crop.top)
  ) {
    return {
      center: { x: image.width / 2, y: image.height / 2 },
      cos: 1,
      sin: 0,
      logical,
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
    identity: false,
  };
}

function cropLogicalSize(header: LinearImageHeader, params: EditParams): Size {
  const image = { width: header.width, height: header.height };
  const crop = params.crop;
  if (
    crop &&
    Number.isFinite(crop.left) &&
    Number.isFinite(crop.top) &&
    Number.isFinite(crop.right) &&
    Number.isFinite(crop.bottom) &&
    crop.right > crop.left &&
    crop.bottom > crop.top
  ) {
    const size = cropOutputSize(crop, image);
    return {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    };
  }
  return image;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new DevelopGlError('Could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new DevelopGlError(`Shader compile failed: ${log}`);
  }
  return shader;
}

function createResources(gl: WebGL2RenderingContext): Resources {
  const program = gl.createProgram();
  if (!program) throw new DevelopGlError('Could not create program');
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new DevelopGlError(`Program link failed: ${log}`);
  }
  const uniforms = Object.fromEntries(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Resources['uniforms'];

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
  return { program, uniforms, curveTexture, uploadedCurve: null };
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

  function setUniforms(u: DevelopUniforms): void {
    const l = res.uniforms;
    gl.useProgram(res.program);
    gl.uniform1i(l.u_image, 0);
    gl.uniform1i(l.u_curve, 1);
    gl.uniform3fv(l.u_wb, u.multipliers);
    gl.uniformMatrix3fv(l.u_color, false, toColumnMajor(u.colorMatrix));
    gl.uniform1f(l.u_exposure, u.exposureGain);
    gl.uniform1i(l.u_toneActive, u.toneActive ? 1 : 0);
    gl.uniform1f(l.u_contrastGamma, u.tone.contrastGamma);
    gl.uniform1f(l.u_highlights, u.tone.highlights);
    gl.uniform1f(l.u_shadows, u.tone.shadows);
    gl.uniform1f(l.u_whites, u.tone.whites);
    gl.uniform1f(l.u_blacks, u.tone.blacks);
    gl.uniform1i(l.u_hasCurve, u.curveLut ? 1 : 0);
    gl.uniform1f(l.u_vibrance, u.vibrance);
    gl.uniform1f(l.u_saturation, u.saturation);

    gl.uniformMatrix3fv(l.u_calibration, false, toColumnMajor(u.calibration.matrix));
    gl.uniform1f(l.u_shadowTint, u.calibration.shadow);
    gl.uniform1i(l.u_mixerActive, u.mixer.active ? 1 : 0);
    gl.uniform1fv(
      l.u_hslHue,
      u.mixer.bands.map((band) => band.hue),
    );
    gl.uniform1fv(
      l.u_hslSat,
      u.mixer.bands.map((band) => band.sat),
    );
    gl.uniform1fv(
      l.u_hslLum,
      u.mixer.bands.map((band) => band.lum),
    );
    gl.uniform1i(l.u_gradingActive, u.grading.active ? 1 : 0);
    const grade = (region: { hue: number; sat: number; lum: number }): number[] => [
      region.hue,
      region.sat,
      region.lum,
      0,
    ];
    gl.uniform4fv(l.u_gradeShadow, grade(u.grading.shadows));
    gl.uniform4fv(l.u_gradeMidtone, grade(u.grading.midtones));
    gl.uniform4fv(l.u_gradeHighlight, grade(u.grading.highlights));
    gl.uniform4fv(l.u_gradeGlobal, grade(u.grading.global));
    gl.uniform1f(l.u_gradeBlending, u.grading.blending);
    gl.uniform1f(l.u_gradeBalance, u.grading.balance);
    const vignette = u.vignette;
    gl.uniform1f(l.u_vignetteAmount, vignette?.amount ?? 0);
    gl.uniform1i(
      l.u_vignetteStyle,
      vignette?.style === 'Color Priority' ? 2 : vignette?.style === 'Paint Overlay' ? 3 : 0,
    );
    gl.uniform1f(l.u_vignetteHighlights, vignette?.highlights ?? 0);
    gl.uniform2f(l.u_vignetteScale, vignette?.scaleX ?? 1, vignette?.scaleY ?? 1);
    gl.uniform1f(l.u_vignettePower, vignette?.power ?? 2);
    gl.uniform1f(l.u_vignetteMidpoint, vignette?.midpoint ?? 0);
    gl.uniform1f(l.u_vignetteFeather, vignette?.feather ?? 0.5);
    gl.uniform1f(l.u_grainAmount, u.grain?.amount ?? 0);
    gl.uniform1f(l.u_grainCell, u.grain?.cell ?? 1);
    gl.uniform1f(l.u_grainCoarse, u.grain?.coarse ?? 0);
    gl.uniform1f(l.u_grainFine, u.grain?.fine ?? 0);
    gl.uniform1ui(l.u_grainSeed, (u.grain?.seed ?? 0) >>> 0);

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

  /**
   * Draws the viewport from one source tile. Fragments whose source sample is
   * not inside the tile's core are discarded, so the tiles partition the output
   * even when rotation makes their output regions non-rectangular (and overlap).
   */
  function drawTile(
    src: Source,
    entry: Source['tiles'][number],
    buffer: Size,
    mapping: Mapping,
    viewport: Rect,
    tileOrigin: { x: number; y: number },
    flipY: boolean,
  ): void {
    const l = res.uniforms;
    const t = entry.tile.texture;
    const core = entry.tile.core;
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.uniform2f(l.u_outSize, buffer.width, buffer.height);
    gl.uniform2f(
      l.u_outScale,
      mapping.logical.width / buffer.width,
      mapping.logical.height / buffer.height,
    );
    gl.uniform2f(l.u_outCenter, mapping.logical.width / 2, mapping.logical.height / 2);
    gl.uniform2f(l.u_tileOrigin, tileOrigin.x, tileOrigin.y);
    gl.uniform2f(l.u_srcCenter, mapping.center.x, mapping.center.y);
    gl.uniform2f(l.u_srcRot, mapping.cos, mapping.sin);
    gl.uniform2f(l.u_srcOrigin, t.x, t.y);
    gl.uniform2f(l.u_srcTexSize, t.w, t.h);
    gl.uniform2f(l.u_srcSize, src.header.width, src.header.height);
    gl.uniform2f(l.u_coreMin, core.x, core.y);
    gl.uniform2f(l.u_coreMax, core.x + core.w, core.y + core.h);
    gl.uniform1f(l.u_flipY, flipY ? 1 : 0);
    gl.uniform1i(
      l.u_nearest,
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

  return {
    get contextLost() {
      return lost;
    },

    setImage(header, data) {
      if (disposed) throw new DevelopGlError('Renderer is disposed');
      if (lost) throw new DevelopGlError('WebGL context lost');
      const view = samplesView(header, data);
      freeSource();
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
      const mapping = mappingFor(src.header, params, cropLogicalSize(src.header, params));
      setUniforms(resolveUniforms(src.header, params, { grainSeed: options.grainSeed }));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const entry of src.tiles) {
        drawTile(
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
      const mapping = mappingFor(src.header, params, cropLogicalSize(src.header, params));

      setUniforms(resolveUniforms(src.header, params, { grainSeed: options.grainSeed }));

      const tileW = Math.min(width, maxOutputTile);
      const tileH = Math.min(height, maxOutputTile);
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
        for (const rect of splitRect({ x: 0, y: 0, w: width, h: height }, maxOutputTile)) {
          for (const entry of src.tiles) {
            drawTile(
              src,
              entry,
              out,
              mapping,
              { x: 0, y: 0, w: rect.w, h: rect.h },
              { x: rect.x, y: rect.y },
              false,
            );
          }
          // Rows come back bottom-up from the framebuffer, which the shader already compensates for.
          gl.readPixels(0, 0, rect.w, rect.h, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
          for (let row = 0; row < rect.h; row++) {
            const from = row * rect.w * 4;
            result.set(
              scratch.subarray(from, from + rect.w * 4),
              ((rect.y + row) * width + rect.x) * 4,
            );
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
        gl.deleteTexture(res.curveTexture);
        gl.deleteProgram(res.program);
      }
    },
  };
}
