import { TUNING as T } from './tuning';

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

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_image;   // camera RGB (RGBA16F), one source tile
uniform sampler2D u_curve;   // tone curve table, RGBA32F, curveLutSize x 1, NEAREST

uniform vec3 u_wb;           // white balance multipliers
uniform mat3 u_color;        // white-balanced camera RGB -> linear Rec.709
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

// Output / source mapping (see renderer.ts): output pixel -> source texel.
uniform vec2 u_outSize;      // size of the whole output image in pixels
uniform vec2 u_tileOrigin;   // output pixel of this render target's (0, 0), top-left based
uniform vec2 u_scale;        // source pixels per output pixel
uniform vec2 u_srcOrigin;    // source pixel of the bound texture's (0, 0)
uniform vec2 u_srcTexSize;
uniform float u_flipY;       // 1 when drawing to the canvas (row 0 at the bottom of the framebuffer)
uniform int u_nearest;       // 1 when output and source sizes match: fetch texels exactly

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

void main() {
  float row = gl_FragCoord.y - 0.5;
  vec2 pix = vec2(gl_FragCoord.x - 0.5, mix(row, u_outSize.y - 1.0 - row, u_flipY)) + u_tileOrigin;

  vec3 cam;
  if (u_nearest == 1) {
    cam = texelFetch(u_image, ivec2(pix - u_srcOrigin), 0).rgb;
  } else {
    cam = texture(u_image, ((pix + 0.5) * u_scale - u_srcOrigin) / u_srcTexSize).rgb;
  }

  vec3 lin = (u_color * clipHighlights(cam, u_wb)) * u_exposure;
  if (u_toneActive == 1) lin = toneRgb(lin);

  vec3 e = vec3(srgbEncode(shoulder(lin.r)), srgbEncode(shoulder(lin.g)), srgbEncode(shoulder(lin.b)));

  if (u_hasCurve == 1) {
    e = vec3(lookupCurve(e.r, 0), lookupCurve(e.g, 1), lookupCurve(e.b, 2));
  }
  if (u_vibrance != 0.0 || u_saturation != 0.0) e = vibranceSaturation(e, u_vibrance, u_saturation);

  outColor = vec4(clamp(e, 0.0, 1.0), 1.0);
}
`;
