import { TONE_TABLE_SIZE } from '../profile/render';

/**
 * GLSL ES 3.00 mirror of `profile/render.ts`: the camera profile's HueSatMap, LookTable, XMP look
 * table, tone curve and look curve. The browser parity test compares it with the CPU reference.
 *
 * The tables are 3D textures read with `texelFetch` and interpolated here (trilinear, with the hue
 * axis wrapping), so no float texture filtering extension is needed and the arithmetic is the CPU's.
 * Texture layout: width = saturation nodes, height = hue nodes, depth = value nodes, RGBA32F
 * (shift, saturation scale, value scale, unused). Table `meta` is `(hue, sat, val, sRGB)`; a hue of 0
 * means the table is absent.
 *
 * Needs `srgbEncode` and `srgbDecode` from the develop shader.
 */

export const PROFILE_UNIFORMS = `
precision highp sampler3D;
uniform int u_profile;             // 1: a camera profile is active
uniform mat3 u_proToWorking;       // linear ProPhoto -> linear Rec.709
uniform mat3 u_workingToPro;
uniform float u_profileGain;       // BaselineExposureOffset as a gain
uniform float u_hsmWeight;         // weight of the second HueSatMap
uniform int u_hasLookCurve;
uniform ivec4 u_hsm1Meta;
uniform ivec4 u_hsm2Meta;
uniform ivec4 u_lookMeta;
uniform ivec4 u_lookXmpMeta;
uniform sampler3D u_hsm1;
uniform sampler3D u_hsm2;
uniform sampler3D u_lookTable;
uniform sampler3D u_lookXmp;
uniform sampler2D u_profileTone;   // R32F, ${TONE_TABLE_SIZE} x 2: row 0 the tone curve, row 1 the XMP look's curve
`;

export const PROFILE_MATH_GLSL = `
const int TONE_SIZE = ${TONE_TABLE_SIZE};

vec3 tableLookup(sampler3D t, ivec4 meta, float h, float s, float v) {
  float hc = (h - floor(h)) * float(meta.x);
  float sc = clamp(s, 0.0, 1.0) * float(meta.y - 1);
  float vc = clamp(v, 0.0, 1.0) * float(meta.z - 1);
  int h0 = min(int(floor(hc)), meta.x - 1);
  int s0 = int(floor(sc));
  int v0 = int(floor(vc));
  float fh = hc - float(h0);
  float fs = sc - float(s0);
  float fv = vc - float(v0);
  int h1 = (h0 + 1) % meta.x;
  int s1 = min(s0 + 1, meta.y - 1);
  int v1 = min(v0 + 1, meta.z - 1);
  vec3 a = mix(texelFetch(t, ivec3(s0, h0, v0), 0).rgb, texelFetch(t, ivec3(s1, h0, v0), 0).rgb, fs);
  vec3 b = mix(texelFetch(t, ivec3(s0, h1, v0), 0).rgb, texelFetch(t, ivec3(s1, h1, v0), 0).rgb, fs);
  vec3 c = mix(texelFetch(t, ivec3(s0, h0, v1), 0).rgb, texelFetch(t, ivec3(s1, h0, v1), 0).rgb, fs);
  vec3 d = mix(texelFetch(t, ivec3(s0, h1, v1), 0).rgb, texelFetch(t, ivec3(s1, h1, v1), 0).rgb, fs);
  return mix(mix(a, b, fh), mix(c, d, fh), fv);
}

// Applies a table's shift and scales to a colour; delta = (hue shift in degrees, saturation scale, value scale).
vec3 hsvTableApply(vec3 rgb, bool encoded, float vEnc, float h, float sat, vec3 delta) {
  float hh = h + delta.x / 360.0;
  hh = (hh - floor(hh)) * 6.0;
  float ss = clamp(sat * delta.y, 0.0, 1.0);
  float vv = encoded ? srgbDecode(vEnc * delta.z) : vEnc * delta.z;
  float c = vv * ss;
  float x = c * (1.0 - abs(mod(hh, 2.0) - 1.0));
  float m = vv - c;
  int sector = int(floor(hh)) % 6;
  vec3 o;
  if (sector == 0) o = vec3(c, x, 0.0);
  else if (sector == 1) o = vec3(x, c, 0.0);
  else if (sector == 2) o = vec3(0.0, c, x);
  else if (sector == 3) o = vec3(0.0, x, c);
  else if (sector == 4) o = vec3(x, 0.0, c);
  else o = vec3(c, 0.0, x);
  return o + m;
}

// Hue (0..1), saturation and max channel of a colour with no negative channel.
vec3 hsvOf(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d >= 1e-9) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, mx > 0.0 ? d / mx : 0.0, mx);
}

vec3 applyHueSatMap(vec3 rgb) {
  vec3 hsv = hsvOf(max(rgb, vec3(0.0)));
  bool encoded = u_hsm1Meta.w == 1 && u_hsm1Meta.z > 1;
  float v = encoded ? srgbEncode(hsv.z) : hsv.z;
  vec3 delta = tableLookup(u_hsm1, u_hsm1Meta, hsv.x, hsv.y, v);
  if (u_hsm2Meta.x > 0 && u_hsmWeight > 0.0) {
    delta = mix(delta, tableLookup(u_hsm2, u_hsm2Meta, hsv.x, hsv.y, v), u_hsmWeight);
  }
  return hsvTableApply(rgb, encoded, v, hsv.x, hsv.y, delta);
}

vec3 applyLookTable(vec3 rgb) {
  vec3 hsv = hsvOf(max(rgb, vec3(0.0)));
  bool encoded = u_lookMeta.w == 1 && u_lookMeta.z > 1;
  float v = encoded ? srgbEncode(hsv.z) : hsv.z;
  return hsvTableApply(rgb, encoded, v, hsv.x, hsv.y, tableLookup(u_lookTable, u_lookMeta, hsv.x, hsv.y, v));
}

vec3 applyXmpLookTable(vec3 rgb) {
  vec3 hsv = hsvOf(clamp(rgb, 0.0, 1.0));
  bool encoded = u_lookXmpMeta.w == 1 && u_lookXmpMeta.z > 1;
  float v = encoded ? srgbEncode(hsv.z) : hsv.z;
  return hsvTableApply(rgb, encoded, v, hsv.x, hsv.y, tableLookup(u_lookXmp, u_lookXmpMeta, hsv.x, hsv.y, v));
}

float toneLookup(float x, int row) {
  float p = clamp(x, 0.0, 1.0) * float(TONE_SIZE - 1);
  int i0 = min(int(floor(p)), TONE_SIZE - 2);
  float f = p - float(i0);
  float a = texelFetch(u_profileTone, ivec2(i0, row), 0).r;
  float b = texelFetch(u_profileTone, ivec2(i0 + 1, row), 0).r;
  return a + (b - a) * f;
}

// The DNG tone curve on a colour: it maps the darkest and brightest channel, the middle one keeps its place.
vec3 toneCurveRgb(vec3 c, int row) {
  c = clamp(c, 0.0, 1.0);
  float low = min(c.r, min(c.g, c.b));
  float high = max(c.r, max(c.g, c.b));
  float a = toneLookup(low, row);
  if (high - low <= 1e-8) return vec3(a);
  float k = (toneLookup(high, row) - a) / (high - low);
  return a + (c - low) * k;
}

vec3 lookCurveRgb(vec3 c) {
  vec3 e = vec3(srgbEncode(clamp(c.r, 0.0, 1.0)), srgbEncode(clamp(c.g, 0.0, 1.0)), srgbEncode(clamp(c.b, 0.0, 1.0)));
  vec3 t = toneCurveRgb(e, 1);
  return vec3(srgbDecode(t.r), srgbDecode(t.g), srgbDecode(t.b));
}

// White-balanced camera RGB to linear Rec.709 through the profile: matrix, HueSatMap, baseline exposure.
vec3 profileBase(vec3 wb) {
  vec3 pro = u_color * wb;
  if (u_hsm1Meta.x > 0) pro = applyHueSatMap(pro);
  return u_proToWorking * (pro * u_profileGain);
}

// Linear Rec.709 (after calibration, exposure and tone) to the sRGB-encoded colour: LookTable, XMP look
// table, tone curve, XMP look curve. It replaces the highlight shoulder.
vec3 profileFinish(vec3 lin) {
  vec3 p = u_workingToPro * lin;
  if (u_lookMeta.x > 0) p = applyLookTable(p);
  if (u_lookXmpMeta.x > 0) p = applyXmpLookTable(clamp(p, 0.0, 1.0));
  p = toneCurveRgb(p, 0);
  if (u_hasLookCurve == 1) p = lookCurveRgb(p);
  vec3 w = u_proToWorking * p;
  return vec3(srgbEncode(w.r), srgbEncode(w.g), srgbEncode(w.b));
}

vec3 baseColor(vec3 wb) {
  return u_profile == 1 ? profileBase(wb) : u_color * wb;
}
`;
