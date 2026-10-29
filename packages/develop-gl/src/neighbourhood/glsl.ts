import { FRAGMENT_COMMON } from '../glsl';
import { TUNING as T } from '../tuning';
import { CLARITY, DEHAZE, DENOISE, MAX_LEVEL, SHARPEN, TEXTURE } from './tuning';

/**
 * GLSL ES 3.00 sources of the neighbourhood passes. Each mirrors the CPU
 * function of the same name in `local.ts`, `denoise.ts` or `sharpen.ts`; the
 * browser parity test compares the two. Intermediate images are RGBA16F
 * textures in "image space": row `j` of a texture is output row `j` of its
 * region (no flip), so passes address texels with `gl_FragCoord` directly.
 */

const f = (n: number): string => {
  const s = String(n);
  return /[.e]/i.test(s) ? s : `${s}.0`;
};
const floats = (values: readonly number[]): string => values.map(f).join(', ');

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 outColor;
const vec3 LUMA = vec3(${floats(T.luma)});
const float LUMINANCE_FLOOR = ${f(T.luminanceFloor)};
`;

/**
 * The base pass: the develop shader's source fetch, white balance, matrix and
 * exposure, writing linear light and its analysis value (log2 luminance).
 * `u_taps` > 1 averages `taps^2` positions per pixel (the measurement copy and
 * the whole-output level 3 are rendered that way); positions are
 * `(pixel + tap) * u_posScale`, clamped to `u_posMax`.
 */
export const BASE_FRAGMENT =
  FRAGMENT_COMMON +
  `
uniform int u_taps;
uniform float u_posScale;
uniform vec2 u_posMax;

vec2 mapSource(vec2 pos) {
  vec2 d = pos * u_outScale - u_outCenter;
  return u_srcCenter + vec2(u_srcRot.x * d.x - u_srcRot.y * d.y, u_srcRot.y * d.x + u_srcRot.x * d.y);
}

void main() {
  vec2 pixel = gl_FragCoord.xy - 0.5 + u_tileOrigin;
  vec2 centre = clamp(mapSource(min((pixel + 0.5) * u_posScale, u_posMax)), vec2(0.0), u_srcSize);
  if (centre.x < u_coreMin.x || centre.y < u_coreMin.y || centre.x > u_coreMax.x || centre.y > u_coreMax.y)
    discard;
  vec4 sum = vec4(0.0);
  for (int b = 0; b < u_taps; b++) {
    for (int a = 0; a < u_taps; a++) {
      vec2 pos = min((pixel + (vec2(float(a), float(b)) + 0.5) / float(u_taps)) * u_posScale, u_posMax);
      vec2 src = clamp(mapSource(pos), vec2(0.0), u_srcSize);
      vec3 cam;
      if (u_nearest == 1) cam = texelFetch(u_image, ivec2(src - u_srcOrigin), 0).rgb;
      else cam = texture(u_image, (src - u_srcOrigin) / u_srcTexSize).rgb;
      vec3 lin = applyCalibration(u_color * clipHighlights(cam, u_wb)) * u_exposure;
      sum += vec4(lin, log2(max(dot(LUMA, lin), LUMINANCE_FLOOR)));
    }
  }
  outColor = sum / float(u_taps * u_taps);
}
`;

/**
 * Where the final passes write: viewport window coordinates, flip, and the region
 * of the source texture; plus the spatial effects (vignette, grain) at that pixel.
 */
const finalPlacement = (declareFlip: boolean): string => `
${declareFlip ? 'uniform float u_flipY;' : ''}
uniform vec2 u_viewOrigin;
uniform float u_viewHeight;
uniform vec2 u_coreOffset;
ivec2 finalTexel() {
  vec2 f = floor(gl_FragCoord.xy) - u_viewOrigin;
  float row = mix(f.y, u_viewHeight - 1.0 - f.y, u_flipY);
  return ivec2(f.x + u_coreOffset.x, row + u_coreOffset.y);
}
// Where output pixel t of the region that starts at u_tileOrigin samples the source (unclamped), and its buffer position.
vec2 finalSource(ivec2 t, out vec2 q) {
  q = u_tileOrigin + vec2(t) + 0.5;
  vec2 d = q * u_outScale - u_outCenter;
  return u_srcCenter + vec2(
    u_srcRot.x * d.x - u_srcRot.y * d.y,
    u_srcRot.y * d.x + u_srcRot.x * d.y
  );
}
// Vignette and grain for the output pixel at texel t; in the crop view they follow the crop frame.
vec3 finalEffects(vec3 e, ivec2 t) {
  vec2 q;
  vec2 src = finalSource(t, q);
  vec2 logN = q * u_outScale / max(u_outCenter, vec2(1.0)) - 1.0;
  if (u_viewMode == 1) {
    logN = (q - (u_frame.xy + u_frame.zw) * 0.5) / max((u_frame.zw - u_frame.xy) * 0.5, vec2(1.0));
  }
  return applyEffects(e, logN, clamp(src, vec2(0.0), u_srcSize), u_outScale.x);
}
// The crop-mode view's last step: empty canvas outside the image (anti-aliased edge), dimmed outside the frame.
vec3 finalView(vec3 e, ivec2 t) {
  if (u_viewMode != 1) return e;
  vec2 q;
  vec2 src = finalSource(t, q);
  vec2 inside = min(src, u_srcSize - src);
  float coverage = clamp(min(inside.x, inside.y) / u_outScale.x + 0.5, 0.0, 1.0);
  bool inFrame = q.x >= u_frame.x && q.y >= u_frame.y && q.x <= u_frame.z && q.y <= u_frame.w;
  if (!inFrame) e *= u_dim;
  return mix(u_outside, e, coverage);
}
`;

/** The per-pixel chain (tone, curve, colour) on the linear image the neighbourhood stages produced. */
export const RESOLVE_FRAGMENT =
  FRAGMENT_COMMON +
  finalPlacement(false) +
  `
uniform sampler2D u_lin2;
uniform float u_linGain;  // exposure, when the neighbourhood passes have not applied it yet
uniform int u_effects;    // 1: this is the last pass: also vignette, grain and the crop view (no sharpening follows)
void main() {
  ivec2 t = finalTexel();
  vec3 e = developColor(texelFetch(u_lin2, t, 0).rgb * u_linGain);
  if (u_effects == 1) e = finalEffects(e, t);
  e = clamp(e, 0.0, 1.0);
  if (u_effects == 1) e = finalView(e, t);
  outColor = vec4(e, 1.0);
}
`;

/** One pyramid level from the one above: the mean of 2x2 texels, as one bilinear tap at the block centre. */
export const DOWN_FRAGMENT =
  HEADER +
  `
uniform sampler2D u_src;
uniform int u_fromAlpha;  // 1: the source holds the analysis value in .a (the base image); keep it in .r
void main() {
  vec4 v = texture(u_src, (2.0 * floor(gl_FragCoord.xy) + 1.0) / vec2(textureSize(u_src, 0)));
  outColor = u_fromAlpha == 1 ? vec4(v.a, 0.0, 0.0, 1.0) : v;
}
`;

const NR_COMMON = `
vec3 up3(sampler2D coarse, vec2 fragCoord) {
  return texture(coarse, fragCoord * 0.5 / vec2(textureSize(coarse, 0))).xyz;
}
`;

/** Linear RGB to the noise reduction space: square-root Y, c1, c2. */
export const NR_PREP_FRAGMENT =
  HEADER +
  `
uniform sampler2D u_lin;
void main() {
  vec3 s = sqrt(max(texelFetch(u_lin, ivec2(gl_FragCoord.xy), 0).rgb, 0.0));
  outColor = vec4((s.r + 2.0 * s.g + s.b) * 0.25, s.r - s.g, s.b - s.g, 1.0);
}
`;

/** Band `l`: this level minus the bilinear expansion of the next coarser one. */
export const NR_BAND_FRAGMENT =
  HEADER +
  NR_COMMON +
  `
uniform sampler2D u_fine;
uniform sampler2D u_coarse;
void main() {
  outColor = vec4(texelFetch(u_fine, ivec2(gl_FragCoord.xy), 0).xyz - up3(u_coarse, gl_FragCoord.xy), 1.0);
}
`;

/** Output of level `l`: the expanded output of `l + 1` plus the band kept where it stands out from the noise. */
export const NR_UP_FRAGMENT =
  HEADER +
  NR_COMMON +
  `
uniform sampler2D u_band;
uniform sampler2D u_coarse;
uniform float u_lumaThreshold;
uniform float u_chromaThreshold;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = textureSize(u_band, 0) - 1;
  float energy = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      float v = texelFetch(u_band, clamp(p + ivec2(dx, dy), ivec2(0), hi), 0).x;
      energy += v * v / 9.0;
    }
  }
  vec3 b = texelFetch(u_band, p, 0).xyz;
  float gl = 1.0;
  if (u_lumaThreshold > 0.0) {
    float x = u_lumaThreshold * u_lumaThreshold / max(energy, 1e-20);
    gl = 1.0 / (1.0 + x * x);
  }
  float gc = 1.0;
  if (u_chromaThreshold > 0.0) {
    float y = u_chromaThreshold * u_chromaThreshold / max(b.y * b.y + b.z * b.z, 1e-20);
    gc = 1.0 / (1.0 + y * y * y);
  }
  outColor = vec4(up3(u_coarse, gl_FragCoord.xy) + b * vec3(gl, gc, gc), 1.0);
}
`;

/** Back from the noise reduction space to linear RGB, with the analysis value recomputed. */
export const NR_FINISH_FRAGMENT =
  HEADER +
  `
uniform sampler2D u_d;
void main() {
  vec3 d = texelFetch(u_d, ivec2(gl_FragCoord.xy), 0).xyz;
  float g = d.x - (d.y + d.z) * 0.25;
  vec3 rgb = max(vec3(g + d.y, g, g + d.z), 0.0);
  rgb *= rgb;
  outColor = vec4(rgb, log2(max(dot(LUMA, rgb), LUMINANCE_FLOOR)));
}
`;

/**
 * Noise measurement: RMS of the finest band's luminance and chroma in 8x8
 * blocks (one fragment each) at the block grid. Blocks whose corner is outside
 * this tile's core are marked -1 so every block is measured by exactly one tile.
 */
export const NOISE_PROBE_FRAGMENT =
  HEADER +
  NR_COMMON +
  `
uniform sampler2D u_fine;
uniform sampler2D u_coarse;
uniform float u_blockX[${DENOISE.maxBlocksX}];
uniform float u_blockY[${DENOISE.maxBlocksY}];
uniform ivec2 u_blocks;
uniform vec2 u_tileOrigin;
uniform vec2 u_coreMin;
uniform vec2 u_coreMax;
// Output -> source mapping, to leave out blocks that are not entirely on the photo (the crop
// view shows empty canvas around it, which is smooth and would read as a noiseless image).
uniform vec2 u_outScale;
uniform vec2 u_outCenter;
uniform vec2 u_srcCenter;
uniform vec2 u_srcRot;
uniform vec2 u_srcSize;
bool onPhoto(vec2 pos) {
  vec2 d = pos * u_outScale - u_outCenter;
  vec2 src = u_srcCenter + vec2(u_srcRot.x * d.x - u_srcRot.y * d.y, u_srcRot.y * d.x + u_srcRot.x * d.y);
  return src.x >= 0.0 && src.y >= 0.0 && src.x <= u_srcSize.x && src.y <= u_srcSize.y;
}
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  if (id.x >= u_blocks.x || id.y >= u_blocks.y) discard;
  vec2 corner = vec2(u_blockX[id.x], u_blockY[id.y]);
  float side = ${f(DENOISE.block)};
  if (!onPhoto(corner) || !onPhoto(corner + vec2(side, 0.0)) || !onPhoto(corner + vec2(0.0, side)) || !onPhoto(corner + vec2(side))) {
    outColor = vec4(-1.0);
    return;
  }
  if (corner.x < u_coreMin.x || corner.y < u_coreMin.y || corner.x >= u_coreMax.x || corner.y >= u_coreMax.y) {
    outColor = vec4(-1.0);
    return;
  }
  ivec2 origin = ivec2(corner - u_tileOrigin);
  float luma = 0.0;
  float chroma = 0.0;
  for (int y = 0; y < ${DENOISE.block}; y++) {
    for (int x = 0; x < ${DENOISE.block}; x++) {
      ivec2 p = origin + ivec2(x, y);
      vec3 band = texelFetch(u_fine, p, 0).xyz - up3(u_coarse, vec2(p) + 0.5);
      luma += band.x * band.x;
      chroma += band.y * band.y + band.z * band.z;
    }
  }
  float n = ${f(DENOISE.block * DENOISE.block)};
  outColor = vec4(sqrt(luma / n), sqrt(chroma / n), 0.0, 1.0);
}
`;

/**
 * The fields Texture and Clarity are made of, which depend on the image and the
 * pyramid but not on the slider amounts or exposure, so they are cached:
 * mode 0 writes Texture's band-pass detail to .r, mode 1 writes the edge-aware
 * blurs of Clarity's four scales to .rgba.
 */
export const FIELDS_FRAGMENT =
  FRAGMENT_COMMON +
  `
uniform sampler2D u_lin;
uniform sampler2D u_l1;
uniform sampler2D u_l2;
uniform sampler2D u_l3;
uniform sampler2D u_g4;
uniform sampler2D u_g5;
uniform sampler2D u_g6;
uniform sampler2D u_g7;
uniform sampler2D u_g8;

// Level k: texture size and the output pixel its texel 0 starts at (tile origin for the local levels, 0 for the whole-output ones).
uniform vec2 u_levelSize[${MAX_LEVEL + 1}];
uniform vec2 u_levelOrigin[${MAX_LEVEL + 1}];

uniform int u_mode;
uniform float u_logScale;
uniform float u_clarityLambda[${CLARITY.scales.length}];

const float TEXTURE_WEIGHT[${TEXTURE.weights.length}] = float[${TEXTURE.weights.length}](${floats(TEXTURE.weights)});
const float TEXTURE_THRESHOLD[${TEXTURE.thresholds.length}] = float[${TEXTURE.thresholds.length}](${floats(TEXTURE.thresholds)});
const float TAP_X[${CLARITY.taps.length}] = float[${CLARITY.taps.length}](${floats(CLARITY.taps.map((t) => t.x))});
const float TAP_Y[${CLARITY.taps.length}] = float[${CLARITY.taps.length}](${floats(CLARITY.taps.map((t) => t.y))});
const float TAP_W[${CLARITY.taps.length}] = float[${CLARITY.taps.length}](${floats(CLARITY.taps.map((t) => t.w))});

// Level k of the analysis pyramid at output position p (pixel centres at x + 0.5).
float level(int k, vec2 p) {
  vec2 uv = ((p - u_levelOrigin[k]) / exp2(float(k))) / u_levelSize[k];
  switch (k) {
    case 0: return textureLod(u_lin, uv, 0.0).a;
    case 1: return textureLod(u_l1, uv, 0.0).r;
    case 2: return textureLod(u_l2, uv, 0.0).r;
    case 3: return textureLod(u_l3, uv, 0.0).r;
    case 4: return textureLod(u_g4, uv, 0.0).r;
    case 5: return textureLod(u_g5, uv, 0.0).r;
    case 6: return textureLod(u_g6, uv, 0.0).r;
    case 7: return textureLod(u_g7, uv, 0.0).r;
    default: return textureLod(u_g8, uv, 0.0).r;
  }
}

// The pyramid at fractional level lambda: a mix of two bilinear levels.
float blurAt(float lambda, vec2 p) {
  float l = clamp(lambda, 0.0, ${f(MAX_LEVEL)});
  int k = min(${MAX_LEVEL - 1}, int(floor(l)));
  float fr = l - float(k);
  float a = level(k, p);
  if (fr == 0.0) return a;
  return a + (level(k + 1, p) - a) * fr;
}

float textureDetail(vec2 p) {
  float sum = 0.0;
  float upper = blurAt(u_logScale, p);
  for (int l = 0; l < ${TEXTURE.weights.length}; l++) {
    float lower = blurAt(u_logScale + float(l + 1), p);
    float band = upper - lower;
    float x = band / TEXTURE_THRESHOLD[l];
    sum += TEXTURE_WEIGHT[l] * band / (1.0 + x * x);
    upper = lower;
  }
  return sum;
}

float edgeAwareBlur(float lambda, vec2 p, float a) {
  float r = exp2(lambda);
  float sum = 0.0;
  float norm = 0.0;
  for (int t = 0; t < ${CLARITY.taps.length}; t++) {
    float v = blurAt(lambda, p + vec2(TAP_X[t], TAP_Y[t]) * r);
    float d = (v - a) / ${f(CLARITY.range)};
    float w = TAP_W[t] / (1.0 + d * d);
    sum += w * v;
    norm += w;
  }
  return sum / norm;
}

void main() {
  vec2 p = floor(gl_FragCoord.xy) + 0.5 + u_tileOrigin;
  if (u_mode == 0) {
    outColor = vec4(textureDetail(p), 0.0, 0.0, 1.0);
    return;
  }
  float a = texelFetch(u_lin, ivec2(gl_FragCoord.xy), 0).a;
  outColor = vec4(
    edgeAwareBlur(u_clarityLambda[0], p, a),
    edgeAwareBlur(u_clarityLambda[1], p, a),
    edgeAwareBlur(u_clarityLambda[2], p, a),
    edgeAwareBlur(u_clarityLambda[3], p, a)
  );
}
`;

/** Texture, Clarity and Dehaze, applied to the linear image from the cached fields; also applies the exposure. */
export const LOCAL_FRAGMENT =
  FRAGMENT_COMMON +
  `
uniform sampler2D u_lin;
uniform sampler2D u_fieldsT;
uniform sampler2D u_fieldsB;
uniform sampler2D u_density;

uniform float u_textureStrength;
uniform float u_clarityWeights[${CLARITY.scales.length * CLARITY.knots}];
uniform int u_clarityOn;
uniform float u_key;
uniform float u_dehaze;
uniform float u_omega;
uniform vec3 u_airlight;

float clarityGain(vec4 blurs, float a) {
  float base = blurs.w;
  float step = ${f((CLARITY.knotHigh - CLARITY.knotLow) / (CLARITY.knots - 1))};
  float u = clamp((base - u_key - (${f(CLARITY.knotLow)})) / step, 0.0, ${f(CLARITY.knots - 1)});
  int k = min(${CLARITY.knots - 2}, int(floor(u)));
  float t = u - float(k);
  float gain = 0.0;
  for (int s = 0; s < ${CLARITY.scales.length}; s++) {
    int row = s * ${CLARITY.knots};
    float w = u_clarityWeights[row + k] * (1.0 - t) + u_clarityWeights[row + k + 1] * t;
    gain += w * (a - blurs[s]);
  }
  return clamp(gain, -${f(CLARITY.maxGain)}, ${f(CLARITY.maxGain)});
}

vec2 mapSource(vec2 pos) {
  vec2 d = pos * u_outScale - u_outCenter;
  return u_srcCenter + vec2(u_srcRot.x * d.x - u_srcRot.y * d.y, u_srcRot.y * d.x + u_srcRot.x * d.y);
}

vec3 dehazePixel(vec3 p, float gain, float density) {
  if (u_dehaze < 0.0) {
    return p + (gain * u_airlight - p) * (${f(DEHAZE.veilStrength)} * -u_dehaze);
  }
  float t = max(1.0 - u_omega * density, ${f(DEHAZE.transmissionFloor)});
  vec3 a = gain * u_airlight;
  vec3 j = (p - a) / t + a;
  float yp = dot(LUMA, p);
  float ratio = yp > 1e-6 ? max(0.0, dot(LUMA, j) / yp) : 0.0;
  return max(j, ${f(DEHAZE.channelFloor)} * p * ratio);
}

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(u_lin, id, 0);
  float gain = 0.0;
  if (u_textureStrength != 0.0) gain += u_textureStrength * texelFetch(u_fieldsT, id, 0).r;
  if (u_clarityOn == 1) gain += clarityGain(texelFetch(u_fieldsB, id, 0), px.a);
  gain = clamp(gain, -${f(CLARITY.maxGain)}, ${f(CLARITY.maxGain)});
  float k = exp2(gain) * u_exposure;
  vec3 rgb = px.rgb * k;
  if (u_dehaze != 0.0) {
    float density = 0.0;
    if (u_dehaze > 0.0) {
      vec2 p = floor(gl_FragCoord.xy) + 0.5 + u_tileOrigin;
      density = texture(u_density, clamp(mapSource(p) / u_srcSize, 0.0, 1.0)).r;
    }
    rgb = dehazePixel(rgb, k, density);
  }
  outColor = vec4(rgb, 1.0);
}
`;

/** Horizontal Gaussian of the encoded luma of the developed image. */
export const BLUR_FRAGMENT =
  HEADER +
  `
uniform sampler2D u_dev;
uniform float u_kernel[${2 * SHARPEN.maxRadius + 1}];
uniform int u_radius;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int hi = textureSize(u_dev, 0).x - 1;
  float sum = 0.0;
  for (int i = -u_radius; i <= u_radius; i++) {
    sum += u_kernel[i + u_radius] * dot(LUMA, texelFetch(u_dev, ivec2(clamp(p.x + i, 0, hi), p.y), 0).rgb);
  }
  outColor = vec4(sum, 0.0, 0.0, 1.0);
}
`;

/** Vertical Gaussian of the blurred luma, then the shaped unsharp mask added to the developed image. */
export const SHARPEN_FRAGMENT =
  FRAGMENT_COMMON +
  finalPlacement(false) +
  `
uniform sampler2D u_dev;
uniform sampler2D u_blurred;
uniform float u_kernel[${2 * SHARPEN.maxRadius + 1}];
uniform int u_radius;
uniform float u_amount;
uniform float u_gain;
uniform float u_threshold;
uniform float u_halo;
uniform float u_dark;
void main() {
  ivec2 p = finalTexel();
  int hi = textureSize(u_dev, 0).y - 1;
  float blur = 0.0;
  for (int i = -u_radius; i <= u_radius; i++) {
    blur += u_kernel[i + u_radius] * texelFetch(u_blurred, ivec2(p.x, clamp(p.y + i, 0, hi)), 0).r;
  }
  vec3 c = texelFetch(u_dev, p, 0).rgb;
  float d = dot(LUMA, c) - blur;
  float mask = u_threshold == 0.0 ? 1.0 : clamp(abs(d) / u_threshold, 0.0, 1.0);
  float k = u_amount * u_gain * mask;
  float ad = abs(d) / u_halo;
  float shaped = d / (1.0 + ad * ad * ad);
  float delta = k * (shaped < 0.0 ? shaped * u_dark : shaped);
  vec3 e = clamp(finalEffects(clamp(c + delta, 0.0, 1.0), p), 0.0, 1.0);
  outColor = vec4(finalView(e, p), 1.0);
}
`;
