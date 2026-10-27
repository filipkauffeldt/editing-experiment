import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './glsl';
import { samplesView, type LinearImageBuffer } from './image';
import { resolveUniforms, type DevelopUniforms } from './params';
import { outputRectOfCore, planSourceTiles, splitRect, type Rect, type SourceTile } from './tiling';
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
  'u_outSize',
  'u_tileOrigin',
  'u_scale',
  'u_srcOrigin',
  'u_srcTexSize',
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

  /** Draws one rectangle of the output from one source tile. `target` is where the pixels go, in framebuffer coordinates. */
  function drawRect(
    src: Source,
    entry: Source['tiles'][number],
    out: { width: number; height: number },
    rect: Rect,
    flipY: boolean,
  ): void {
    const l = res.uniforms;
    const { header } = src;
    const t = entry.tile.texture;
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.uniform2f(l.u_outSize, out.width, out.height);
    gl.uniform2f(l.u_scale, header.width / out.width, header.height / out.height);
    gl.uniform2f(l.u_srcOrigin, t.x, t.y);
    gl.uniform2f(l.u_srcTexSize, t.w, t.h);
    gl.uniform1f(l.u_flipY, flipY ? 1 : 0);
    gl.uniform1i(l.u_nearest, out.width === header.width && out.height === header.height ? 1 : 0);
    if (flipY) {
      // Canvas: window coordinates are absolute, so the viewport places the rect.
      gl.uniform2f(l.u_tileOrigin, 0, 0);
      gl.viewport(rect.x, out.height - rect.y - rect.h, rect.w, rect.h);
    } else {
      // Framebuffer: the target holds just this rect, so shift the pixel coordinates.
      gl.uniform2f(l.u_tileOrigin, rect.x, rect.y);
      gl.viewport(0, 0, rect.w, rect.h);
    }
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
      return resolveUniforms(requireSource().header, params);
    },

    render(params) {
      const src = requireSource();
      const out = { width: canvas.width, height: canvas.height };
      setUniforms(resolveUniforms(src.header, params));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const entry of src.tiles) {
        const rect = outputRectOfCore(entry.tile.core, src.header, out);
        if (rect.w > 0 && rect.h > 0) drawRect(src, entry, out, rect, true);
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

      setUniforms(resolveUniforms(src.header, params));

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
        for (const entry of src.tiles) {
          const coreRect = outputRectOfCore(entry.tile.core, src.header, out);
          for (const rect of splitRect(coreRect, maxOutputTile)) {
            drawRect(src, entry, out, rect, false);
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
