import { COLOR_TUNING as C } from '../color/tuning';

/**
 * GLSL ES 3.00 for the per-pixel colour and effects stages, mirroring
 * `src/color/*.ts`. Keep the two in step: the browser parity test compares them
 * pixel by pixel. The maths is ported from RAWmakase (MIT); see
 * `third_party/rawmakase/LICENSE` and `docs/ARCHITECTURE.md`.
 */

const f = (n: number): string => {
  const s = String(n);
  return /[.e]/i.test(s) ? s : `${s}.0`;
};

const exp2 = (n: number): string => `pow(2.0, ${f(n)})`;

export const COLOR_UNIFORMS = `uniform mat3 u_calibration;  // Camera Calibration (linear light)
uniform float u_shadowTint;
uniform int u_mixerActive;
uniform float u_hslHue[8];   // Color Mixer bands: Red..Magenta, -1..1
uniform float u_hslSat[8];
uniform float u_hslLum[8];
uniform int u_gradingActive;
uniform vec4 u_gradeShadow;  // hue degrees, saturation 0..1, luminance -1..1
uniform vec4 u_gradeMidtone;
uniform vec4 u_gradeHighlight;
uniform vec4 u_gradeGlobal;
uniform float u_gradeBlending;
uniform float u_gradeBalance;
uniform float u_vignetteAmount;
uniform int u_vignetteStyle; // 0 Highlight Priority, 2 Color Priority, 3 Paint Overlay
uniform float u_vignetteHighlights;
uniform vec2 u_vignetteScale;
uniform float u_vignettePower;
uniform float u_vignetteMidpoint;
uniform float u_vignetteFeather;
uniform float u_grainAmount;
uniform float u_grainCell;
uniform float u_grainCoarse;
uniform float u_grainFine;
uniform uint u_grainSeed;
`;

const BAND_HUES = C.bandHues.map(f).join(', ');

export const COLOR_MATH_GLSL = `
// --- Camera Calibration (linear light) ---------------------------------------
vec3 applyCalibration(vec3 p) {
  vec3 q = u_calibration * p;
  if (u_shadowTint == 0.0) return q;
  float y = max(dot(LUMA, q), 0.0);
  float amount = abs(u_shadowTint) * y * exp(-6.0 * y);
  vec3 direction = u_shadowTint > 0.0
    ? vec3(${f(0.116)}, ${f(-0.189)}, ${f(-0.002)})
    : vec3(${f(-0.331)}, ${f(0.029)}, ${f(-0.152)});
  return q + amount * direction;
}

// --- Color Mixer (encoded sRGB) ----------------------------------------------
vec3 hsvToRgbG(vec3 hsv) {
  float hh = fract(hsv.x) * 6.0;
  float c = hsv.z * hsv.y;
  float x = c * (1.0 - abs(mod(hh, 2.0) - 1.0));
  float m = hsv.z - c;
  vec3 q;
  if (hh < 1.0) q = vec3(c, x, 0.0);
  else if (hh < 2.0) q = vec3(x, c, 0.0);
  else if (hh < 3.0) q = vec3(0.0, c, x);
  else if (hh < 4.0) q = vec3(0.0, x, c);
  else if (hh < 5.0) q = vec3(x, 0.0, c);
  else q = vec3(c, 0.0, x);
  return q + m;
}

vec3 rgbToHsvG(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 0.0) {
    if (mx == c.r) h = (c.g - c.b) / d / 6.0;
    else if (mx == c.g) h = ((c.b - c.r) / d + 2.0) / 6.0;
    else h = ((c.r - c.g) / d + 4.0) / 6.0;
    h = fract(h);
  }
  return vec3(h, mx > 0.0 ? d / mx : 0.0, mx);
}

float bandWeightG(float hue, float centerDegrees) {
  float distance = abs(hue * 360.0 - centerDegrees);
  distance = min(distance, 360.0 - distance);
  float t = clamp(1.0 - distance / ${f(C.bandHalfWidth)}, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

vec3 applyColorMixer(vec3 c) {
  if (u_mixerActive == 0) return c;
  vec3 hsv = rgbToHsvG(c);
  float gate = smoothstep(${f(C.neutralSaturation.from)}, ${f(C.neutralSaturation.to)}, hsv.y);
  if (gate == 0.0 || hsv.z == 0.0) return c;
  const float CENTERS[8] = float[8](${BAND_HUES});
  float hueShift = 0.0;
  float satScale = 0.0;
  float valueScale = 0.0;
  for (int i = 0; i < 8; i++) {
    float weight = bandWeightG(hsv.x, CENTERS[i]) * gate;
    hueShift += u_hslHue[i] * weight;
    satScale += u_hslSat[i] * weight;
    valueScale += u_hslLum[i] * weight;
  }
  float hue = hsv.x + hueShift * ${f(C.hslHueDegrees)} / 360.0;
  float saturation = clamp(hsv.y * max(0.0, 1.0 + satScale * ${f(C.hslSaturationStrength)}), 0.0, 1.0);
  float value = max(0.0, hsv.z * max(0.0, 1.0 + valueScale * ${f(C.hslLuminanceStrength)}));
  return hsvToRgbG(vec3(hue, saturation, value));
}

// --- Color Grading (encoded sRGB) --------------------------------------------
float gradeWeight(float e, float center, float width, float balance, bool shadows) {
  float moved = center + (shadows ? balance : -balance) * ${f(C.gradeBalanceShift)};
  float d = (e - moved) / width;
  return exp(-0.5 * d * d);
}

vec3 gradeTint(float hueDegrees) {
  vec3 rgb = hsvToRgbG(vec3(hueDegrees / 360.0, 1.0, 1.0));
  float y = dot(LUMA, rgb);
  return rgb - vec3(y);
}

vec3 gradeRegion(vec3 c, vec4 region, float weight) {
  if (weight == 0.0) return c;
  vec3 res = c;
  if (region.y != 0.0) {
    vec3 tint = gradeTint(region.x);
    float amount = weight * region.y * ${f(C.gradeTintStrength)};
    res = max(vec3(0.0), res * (vec3(1.0) + tint * amount));
  }
  if (region.z != 0.0) res += vec3(region.z * weight * ${f(C.gradeLuminanceStrength)});
  return res;
}

vec3 applyColorGrading(vec3 c) {
  if (u_gradingActive == 0) return c;
  float e = dot(LUMA, c);
  float width = ${f(C.gradeWidth)} + u_gradeBlending * ${f(C.gradeWidthPerBlending)};
  c = gradeRegion(c, u_gradeShadow,
    gradeWeight(e, ${f(C.gradeCentres.shadows)}, width, u_gradeBalance, true));
  c = gradeRegion(c, u_gradeMidtone,
    gradeWeight(e, ${f(C.gradeCentres.midtones)}, width, u_gradeBalance, false));
  c = gradeRegion(c, u_gradeHighlight,
    gradeWeight(e, ${f(C.gradeCentres.highlights)}, width, u_gradeBalance, false));
  c = gradeRegion(c, u_gradeGlobal, 1.0);
  return c;
}

// --- Post-crop vignette (encoded sRGB) ---------------------------------------
float vignetteMaskG(vec2 n) {
  float q = clamp(
    (pow(abs(n.x * u_vignetteScale.x), u_vignettePower) +
     pow(abs(n.y * u_vignetteScale.y), u_vignettePower)) / 2.0,
    1e-6, 1.0 - 1e-6);
  float z = clamp((log(q / (1.0 - q)) - u_vignetteMidpoint) / u_vignetteFeather, -40.0, 40.0);
  return 1.0 / (1.0 + exp(-z));
}

vec3 paintDarkenG(vec3 b, float amount, float mask) {
  float gain = 1.0 - (1.0 - srgbDecode(1.0 - amount)) * (1.0 - srgbDecode(1.0 - mask));
  return b * gain;
}

float vignetteProtect(float y) {
  if (u_vignetteHighlights <= 0.0) return 1.0;
  return pow(1.0 - smoothstep(${f(C.vignette.highlightProtect.from)},
    ${f(C.vignette.highlightProtect.to)}, y),
    pow(u_vignetteHighlights, ${f(C.vignette.highlightProtect.exponent)}));
}

vec3 applyVignette(vec3 encoded, vec2 n) {
  float mask = vignetteMaskG(n);
  vec3 b = vec3(srgbDecode(encoded.r), srgbDecode(encoded.g), srgbDecode(encoded.b));
  vec3 res;
  if (u_vignetteAmount > 0.0) {
    float x = u_vignetteAmount;
    if (u_vignetteStyle == 3) {
      float opacity = srgbDecode(x) * srgbDecode(mask);
      res = b + (vec3(1.0) - b) * opacity;
    } else {
      float strength = u_vignetteStyle == 2
        ? ${f(C.vignette.colorPriorityLighten)}
        : ${f(C.vignette.highlightPriorityLighten)};
      float opacity = strength * srgbDecode(x) * srgbDecode(mask);
      float white = ${exp2(C.vignette.sceneWhiteEv)};
      res = clamp(b + (vec3(white) - b) * opacity, 0.0, 1.0);
    }
  } else {
    float x = abs(u_vignetteAmount);
    float shape = ${f(1.7625)} + ${f(0.6875)} * x * x;
    float gain = 1.0 - ${f(C.vignette.paintDarken)} * (1.0 - srgbDecode(1.0 - x)) *
      (1.0 - pow(1.0 - mask, shape));
    if (u_vignetteStyle == 3) {
      res = paintDarkenG(b, x, mask);
    } else {
      float y = dot(LUMA, b);
      float protect = vignetteProtect(y);
      vec3 exposed = b * pow(gain, protect);
      if (u_vignetteStyle == 2) {
        vec3 painted = paintDarkenG(b, x, mask);
        float w = ${f(C.vignette.colorPriorityMix.base)} +
          ${f(C.vignette.colorPriorityMix.perAmount)} * x;
        res = pow(exposed, vec3(1.0 - w)) * pow(painted, vec3(w));
      } else {
        res = exposed;
      }
    }
  }
  return vec3(srgbEncode(res.r), srgbEncode(res.g), srgbEncode(res.b));
}

// --- Grain (encoded sRGB) ----------------------------------------------------
float grainHashG(int x, int y, uint seed) {
  uint v = (uint(x) * 0x9e3779b9u) ^ (uint(y) * 0x85ebca6bu) ^ seed;
  v ^= v >> 16;
  v *= 0x7feb352du;
  v ^= v >> 15;
  v *= 0x846ca68bu;
  v ^= v >> 16;
  return float(v) / 4294967295.0 * 2.0 - 1.0;
}

float grainValueNoise(vec2 p, float cell, uint seed) {
  vec2 c = p / cell;
  vec2 i = floor(c);
  vec2 s = fract(c);
  s = s * s * (3.0 - 2.0 * s);
  float top = mix(grainHashG(int(i.x), int(i.y), seed),
    grainHashG(int(i.x) + 1, int(i.y), seed), s.x);
  float bottom = mix(grainHashG(int(i.x), int(i.y) + 1, seed),
    grainHashG(int(i.x) + 1, int(i.y) + 1, seed), s.x);
  return mix(top, bottom, s.y);
}

float grainStrength(float l) {
  const float X[9] = float[9](${C.grain.luminance.map(f).join(', ')});
  const float Y[9] = float[9](${C.grain.luminanceGain.map(f).join(', ')});
  if (l <= X[0]) return Y[0];
  for (int i = 1; i < 9; i++) {
    if (l <= X[i]) {
      return mix(Y[i - 1], Y[i], (l - X[i - 1]) / (X[i] - X[i - 1]));
    }
  }
  return Y[8];
}

float grainNoiseG(vec2 pos, float scale, float l) {
  float averaged = min(u_grainCell * scale, 1.0);
  float coarse = grainValueNoise(pos, u_grainCell, u_grainSeed) * averaged;
  float fine = grainHashG(int(floor(pos.x)), int(floor(pos.y)), u_grainSeed ^ 0x21f09u) *
    min(scale, 1.0);
  return (coarse * u_grainCoarse + fine * u_grainFine) * u_grainAmount * grainStrength(l);
}

vec3 applyEffects(vec3 encoded, vec2 logN, vec2 srcPos, float scale) {
  if (u_vignetteAmount != 0.0) encoded = applyVignette(encoded, logN);
  if (u_grainAmount != 0.0) {
    float noise = grainNoiseG(srcPos, scale, dot(LUMA, encoded));
    encoded = clamp(encoded + vec3(noise), 0.0, 1.0);
  }
  return encoded;
}
`;
