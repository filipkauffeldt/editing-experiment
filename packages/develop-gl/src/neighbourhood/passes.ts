import { DevelopGlError } from '../errors';
import { VERTEX_SHADER } from '../glsl';

/** Small helpers for the pass graph: programs, a pool of float textures and full-target draws. */

export type ImageFormat = 'rgba16f' | 'rgba32f';

/** A texture that is also a render target. */
export interface Image {
  texture: WebGLTexture;
  w: number;
  h: number;
  format: ImageFormat;
}

export interface GlProgram {
  program: WebGLProgram;
  /** Location of a uniform, or null if the shader does not use it (setting a null location is a no-op). */
  loc(name: string): WebGLUniformLocation | null;
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

export function createProgram(gl: WebGL2RenderingContext, fragment: string): GlProgram {
  const program = gl.createProgram();
  if (!program) throw new DevelopGlError('Could not create program');
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
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
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    loc(name) {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
      return cache.get(name) ?? null;
    },
  };
}

/** Float textures rendered to and sampled by the passes; freed ones are reused by size. */
export class ImagePool {
  private readonly free = new Map<string, Image[]>();
  private readonly all = new Set<Image>();

  constructor(private readonly gl: WebGL2RenderingContext) {}

  acquire(w: number, h: number, format: ImageFormat = 'rgba16f'): Image {
    const key = `${format}:${w}x${h}`;
    const reused = this.free.get(key)?.pop();
    if (reused) return reused;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new DevelopGlError('Could not create texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // 32-bit float textures are not filterable without an extension; they are only read back or fetched.
    const filter = format === 'rgba32f' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (format === 'rgba32f') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    }
    const image = { texture, w, h, format };
    this.all.add(image);
    return image;
  }

  release(image: Image | undefined): void {
    if (!image) return;
    const key = `${image.format}:${image.w}x${image.h}`;
    const list = this.free.get(key) ?? [];
    if (!list.includes(image)) list.push(image);
    this.free.set(key, list);
  }

  dispose(): void {
    for (const image of this.all) this.gl.deleteTexture(image.texture);
    this.all.clear();
    this.free.clear();
  }
}

/** Draws full-screen passes into float targets through one shared framebuffer. */
export class PassRunner {
  private readonly framebuffer: WebGLFramebuffer;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const fb = gl.createFramebuffer();
    if (!fb) throw new DevelopGlError('Could not create framebuffer');
    this.framebuffer = fb;
  }

  /** Binds `target` as the framebuffer, or the given framebuffer/canvas when it is not an image. */
  bindTarget(target: Image | WebGLFramebuffer | null): void {
    const gl = this.gl;
    if (target && 'texture' in target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        target.texture,
        0,
      );
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    }
  }

  /** Binds textures to units 0.. in order. */
  bindInputs(inputs: readonly (Image | WebGLTexture)[]): void {
    const gl = this.gl;
    inputs.forEach((input, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, 'texture' in input ? input.texture : input);
    });
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Runs `program` over the whole of `target` with `inputs` on units 0..; `setup` sets its uniforms. */
  run(
    program: GlProgram,
    inputs: readonly (Image | WebGLTexture)[],
    target: Image,
    setup?: (gl: WebGL2RenderingContext) => void,
  ): void {
    this.draw(program, inputs, target, { x: 0, y: 0, w: target.w, h: target.h }, setup);
  }

  /** Like {@link run} into a viewport of an image, framebuffer or (null) the canvas. */
  draw(
    program: GlProgram,
    inputs: readonly (Image | WebGLTexture)[],
    target: Image | WebGLFramebuffer | null,
    viewport: { x: number; y: number; w: number; h: number },
    setup?: (gl: WebGL2RenderingContext) => void,
  ): void {
    const gl = this.gl;
    this.bindTarget(target);
    gl.useProgram(program.program);
    this.bindInputs(inputs);
    setup?.(gl);
    gl.viewport(viewport.x, viewport.y, viewport.w, viewport.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.framebuffer);
  }
}
