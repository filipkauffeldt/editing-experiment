import { TUNING as T } from './tuning';
import { COLOR_MATH_GLSL, COLOR_UNIFORMS } from './glsl/color';
import { LENS_MATH_GLSL, LENS_UNIFORMS } from './glsl/lens';
import { PROFILE_MATH_GLSL, PROFILE_UNIFORMS } from './glsl/profile';

/**
 * GLSL ES 3.00 sources of the develop pipeline. Each function mirrors the
 * function of the same name in `ops.ts` (see there for what it does and why);
 * the numbers come from `tuning.ts`. Keep both in step: the browser parity test
 * compares them pixel by pixel.
 */

/** Formats a number as a GLSL float literal with full precision. */
const f = (n: number): string => {
  const s = String(n);
  return /[.e]/i.test(s) ? s : `${s}.0`;
};

export const VERTEX_SHADER = `#version 300 es
// Full-screen triangle from gl_VertexID, so there are no buffers to manage.
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Everything of the develop fragment shader before `main`: uniforms, helpers and the per-pixel colour chain. */
export const FRAGMENT_COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_image;   // camera RGB (RGBA16F), one source tile
uniform sampler2D u_curve;   // tone curve table, RGBA32F, curveLutSize x 1, NEAREST

uniform vec3 u_wb;           // white balance multipliers
uniform mat3 u_color;        // white-balanced camera RGB -> linear Rec.709 (linear ProPhoto with a camera profile)
uniform float u_exposure;    // linear gain
uniform int u_toneActive;
uniform float u_contrastGamma;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whites;
uniform float u_blacks;
uniform int u_hasCurve;
uniform float u_vibrance;
uniform float u_saturation;

// View-only clipping overlay (J), applied after the develop chain; exports pass 0.
uniform float u_clipShadows;
uniform float u_clipHighlights;

// EE colour/effects insertion point: uniforms.
${COLOR_UNIFORMS}

// Lens corrections: where the corrected frame is recorded, lateral CA and the vignetting gain.
${LENS_UNIFORMS}

// Camera profile (DCP): HueSatMap, LookTable, tone curve. Off unless u_profile is 1.
${PROFILE_UNIFORMS}

// Output / source mapping (see renderer.ts and crop.ts): output pixel -> source texel.
uniform vec2 u_outSize;      // size of this render target in pixels (buffer, not logical crop size)
uniform vec2 u_outScale;     // logical output pixels per buffer pixel (crop preview scaling)
uniform vec2 u_outCenter;    // centre of the logical output in pixels
uniform vec2 u_tileOrigin;   // buffer pixel of this tile's (0, 0), top-left based
uniform vec2 u_srcCenter;    // crop centre in source pixels (rotation pivot)
uniform vec2 u_srcRot;       // cos(angle), sin(angle): clockwise rotation from output to source
uniform vec2 u_srcOrigin;    // source pixel of the bound texture's (0, 0)
uniform vec2 u_srcTexSize;
uniform vec2 u_srcSize;      // full source size, for CLAMP_TO_EDGE at the image border
uniform vec2 u_coreMin;      // source rectangle this tile owns; fragments outside are drawn by another tile
uniform vec2 u_coreMax;
uniform float u_flipY;       // 1 when drawing to the canvas (row 0 at the bottom of the framebuffer)
uniform int u_nearest;       // 1 when output and source sizes match: fetch texels exactly
uniform int u_viewMode;      // 1 for the crop-mode view: empty canvas outside the image, dimmed outside the frame
uniform vec4 u_frame;        // view mode: crop frame (minX, minY, maxX, maxY) in buffer pixels, top-left based
uniform float u_dim;         // view mode: gain applied outside the frame
uniform vec3 u_outside;      // view mode: sRGB colour of the empty canvas outside the image

out vec4 outColor;

const float MID_GREY = ${f(T.midGrey)};
const float LUMINANCE_FLOOR = ${f(T.luminanceFloor)};
const vec3 LUMA = vec3(${f(T.luma[0])}, ${f(T.luma[1])}, ${f(T.luma[2])});
const float CURVE_SIZE = ${f(T.curveLutSize)};

vec3 clipHighlights(vec3 raw, vec3 wb) {
  float limit = min(wb.r, min(wb.g, wb.b));
  vec3 c = min(raw * wb, vec3(limit));
  float t = smoothstep(${f(T.clipKnee)}, 1.0, max(raw.r, max(raw.g, raw.b)));
  float neutral = max(c.r, max(c.g, c.b));
  return c + (vec3(neutral) - c) * t;
}

float srgbEncode(float x) {
  return x <= 0.0031308 ? max(x, 0.0) * 12.92 : 1.055 * pow(max(x, 0.0031308), 1.0 / 2.4) - 0.055;
}

float srgbDecode(float e) {
  return e <= 0.04045 ? max(e, 0.0) / 12.92 : pow((max(e, 0.04045) + 0.055) / 1.055, 2.4);
}

// EE colour/effects insertion point: maths (ported from RAWmakase, MIT).
${COLOR_MATH_GLSL}

${LENS_MATH_GLSL}

${PROFILE_MATH_GLSL}

float highlightsShadows(float y, float highlights, float shadows) {
  float e = srgbEncode(y);
  float stops =
    highlights * ${f(T.highlightsStops)} * smoothstep(${f(T.highlightsMask.from)}, ${f(T.highlightsMask.to)}, e) +
    shadows * ${f(T.shadowsStops)} * (1.0 - smoothstep(${f(T.shadowsMask.from)}, ${f(T.shadowsMask.to)}, e));
  return y * exp2(stops);
}

float contrastCurve(float e, float gamma) {
  float m = srgbEncode(MID_GREY);
  if (e >= 1.0) return e;
  if (e <= m) return m * pow(e / m, gamma);
  return 1.0 - (1.0 - m) * pow((1.0 - e) / (1.0 - m), gamma);
}

float whitesBlacks(float e, float whites, float blacks) {
  float c = clamp(e, 0.0, 1.0);
  return e +
    whites * ${f(T.whitesStrength)} * pow(c, ${f(T.endpointFalloff)}) +
    blacks * ${f(T.blacksStrength)} * pow(1.0 - c, ${f(T.endpointFalloff)});
}

float toneLuminance(float y) {
  float y1 = highlightsShadows(y, u_highlights, u_shadows);
  float e2 = contrastCurve(srgbEncode(y1), u_contrastGamma);
  float e3 = whitesBlacks(e2, u_whites, u_blacks);
  return srgbDecode(e3);
}

vec3 toneRgb(vec3 rgb) {
  float y = max(dot(LUMA, rgb), LUMINANCE_FLOOR);
  return rgb * (toneLuminance(y) / y);
}

float shoulder(float x) {
  const float k = ${f(T.shoulderKnee)};
  const float xw = ${f(T.shoulderWhite)};
  if (x <= k) return max(x, 0.0);
  if (x >= xw) return 1.0;
  float t = (x - k) / (1.0 - k);
  float w = (xw - k) / (1.0 - k);
  return k + (1.0 - k) * ((t * (1.0 + t / (w * w))) / (1.0 + t));
}

float lookupCurve(float e, int channel) {
  float p = clamp(e, 0.0, 1.0) * (CURVE_SIZE - 1.0);
  int i0 = min(int(floor(p)), int(CURVE_SIZE) - 2);
  float fr = p - float(i0);
  float a = texelFetch(u_curve, ivec2(i0, 0), 0)[channel];
  float b = texelFetch(u_curve, ivec2(i0 + 1, 0), 0)[channel];
  return a + (b - a) * fr;
}

float hueDegrees(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float d = mx - min(c.r, min(c.g, c.b));
  if (d <= 0.0) return 0.0;
  float h;
  if (mx == c.r) h = (c.g - c.b) / d;
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  h *= 60.0;
  return h < 0.0 ? h + 360.0 : h;
}

vec3 vibranceSaturation(vec3 c, float vibrance, float saturation) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float s = mx > 0.0 ? (mx - mn) / mx : 0.0;
  float dh = abs(hueDegrees(c) - ${f(T.skinHue)});
  dh = min(dh, 360.0 - dh);
  float skin = 1.0 - smoothstep(0.0, ${f(T.skinHueWidth)}, dh);
  float weight = (1.0 - s) * (1.0 - ${f(T.skinProtection)} * skin);
  float factor = max(0.0, (1.0 + vibrance * weight) * (1.0 + saturation));
  float l = dot(LUMA, c);
  return l + (c - l) * factor;
}

/** View-only clipping overlay: red where a highlight channel clips, blue where a shadow channel crushes. */
vec3 applyClipping(vec3 e) {
  if (u_clipHighlights > 0.5 && max(e.r, max(e.g, e.b)) >= ${f(T.clippingHigh)})
    return vec3(1.0, 0.0, 0.0);
  if (u_clipShadows > 0.5 && min(e.r, min(e.g, e.b)) <= ${f(T.clippingLow)})
    return vec3(0.0, 0.25, 1.0);
  return e;
}

/** Linear light after white balance, calibration and exposure to the sRGB-encoded colour: tone, curves, colour. Not clamped. */
vec3 developColor(vec3 lin) {
  if (u_toneActive == 1) lin = toneRgb(lin);

  // A camera profile's tone curve takes the place of the highlight shoulder.
  vec3 e = u_profile == 1
    ? profileFinish(lin)
    : vec3(srgbEncode(shoulder(lin.r)), srgbEncode(shoulder(lin.g)), srgbEncode(shoulder(lin.b)));

  if (u_hasCurve == 1) {
    e = vec3(lookupCurve(e.r, 0), lookupCurve(e.g, 1), lookupCurve(e.b, 2));
  }
  if (u_vibrance != 0.0 || u_saturation != 0.0) e = vibranceSaturation(e, u_vibrance, u_saturation);

  // EE colour/effects insertion point: per-pixel colour.
  e = applyColorMixer(e);
  return applyDefringe(applyColorGrading(e));
}

`;

/** The develop pass: source fetch and the whole per-pixel chain in one shader (no neighbourhood ops). */
export const FRAGMENT_SHADER =
  FRAGMENT_COMMON +
  `void main() {
  float row = gl_FragCoord.y - 0.5;
  vec2 pix = vec2(gl_FragCoord.x - 0.5, mix(row, u_outSize.y - 1.0 - row, u_flipY)) + u_tileOrigin;
  vec2 pOut = (pix + 0.5) * u_outScale;
  vec2 d = pOut - u_outCenter;
  // CropAngle is clockwise: the output samples the source through the inverse
  // rotation around the crop centre. Bilinear sampling is the texture's LINEAR filter.
  vec2 src = u_srcCenter + vec2(
    u_srcRot.x * d.x - u_srcRot.y * d.y,
    u_srcRot.y * d.x + u_srcRot.x * d.y
  );
  // Signed distance (buffer pixels, negative outside) to the nearest image edge,
  // for the crop view's anti-aliased image border. u_outScale is source px per buffer px.
  float coverage = 1.0;
  if (u_viewMode == 1) {
    vec2 inside = min(src, u_srcSize - src);
    coverage = clamp(min(inside.x, inside.y) / u_outScale.x + 0.5, 0.0, 1.0);
  }
  // Sample outside the image clamps to the edge, like the CPU reference and
  // CLAMP_TO_EDGE; clamping first also puts that fragment in the edge core.
  src = clamp(src, vec2(0.0), u_srcSize);
  // Lens corrections move where the corrected frame was recorded; the tile that owns that
  // recorded position draws the fragment.
  float lensQ;
  vec2 recorded = lensRecorded(src, lensQ);
  vec2 rec = clamp(recorded, vec2(0.0), u_srcSize);
  if (rec.x < u_coreMin.x || rec.y < u_coreMin.y || rec.x > u_coreMax.x || rec.y > u_coreMax.y)
    discard;
  if (coverage <= 0.0) {
    outColor = vec4(u_outside, 1.0);
    return;
  }

  float gain;
  vec3 cam = lensCam(recorded, lensQ, gain);

  // EE colour/effects insertion point: calibration sits next to the camera matrix.
  vec3 lin = applyCalibration(baseColor(clipHighlights(cam, u_wb) * gain)) * u_exposure;
  vec3 e = developColor(lin);

  // Spatial effects come last.
  vec2 logN = pOut / max(u_outCenter, vec2(1.0)) - 1.0;
  vec2 q = pix + 0.5;
  if (u_viewMode == 1) {
    // Effects follow the crop frame, as they will in the committed crop.
    logN = (q - (u_frame.xy + u_frame.zw) * 0.5) / max((u_frame.zw - u_frame.xy) * 0.5, vec2(1.0));
  }
  e = applyEffects(e, logN, src, u_outScale.x);

  e = clamp(e, 0.0, 1.0);
  if (u_viewMode == 1) {
    bool inFrame = q.x >= u_frame.x && q.y >= u_frame.y && q.x <= u_frame.z && q.y <= u_frame.w;
    if (!inFrame) e *= u_dim;
    e = mix(u_outside, e, coverage);
  }
  e = applyClipping(e);
  outColor = vec4(e, 1.0);
}
`;
