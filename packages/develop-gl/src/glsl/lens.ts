import {
  CA_TERMS,
  DISTORTION_TERMS,
  VIGNETTE_DENOMINATOR_TERMS,
  VIGNETTE_NUMERATOR_TERMS,
} from '../lens/model';

/**
 * GLSL of the lens corrections; mirrors `lens/model.ts` (`lensSample`, `lensGain`), which the CPU
 * reference evaluates. Positions are in source pixels. Needs `u_image`, `u_srcSize`,
 * `u_srcOrigin`, `u_srcTexSize` and `u_nearest` from the develop shader.
 */

export const LENS_UNIFORMS = `
uniform int u_lensGeometry;        // distortion, manual distortion or lateral CA move the sample
uniform int u_lensGain;            // a vignetting gain applies
uniform vec2 u_lensCentre;         // optical centre
uniform vec3 u_lensFrame;          // image centre x, y and half diagonal
uniform int u_lensHasDist;
uniform float u_lensDist[${DISTORTION_TERMS}];
uniform float u_lensDistUnit;
uniform float u_lensManual;
uniform int u_lensHasCa;
uniform float u_lensRed[${CA_TERMS}];
uniform float u_lensBlue[${CA_TERMS}];
uniform float u_lensCaUnit;
uniform int u_lensCaAtSource;
uniform int u_lensHasVig;
uniform float u_lensVigNum[${VIGNETTE_NUMERATOR_TERMS}];
uniform float u_lensVigDen[${VIGNETTE_DENOMINATOR_TERMS}];
uniform float u_lensVigUnit;
uniform float u_lensVigExp;
uniform int u_lensHasManualVig;
uniform vec4 u_lensManualVig;      // amount, scale, power, knee
`;

const horner = (name: string, array: string, terms: number): string => `
float ${name}(float x) {
  float sum = ${array}[${terms - 1}];
  for (int i = ${terms - 2}; i >= 0; i--) sum = sum * x + ${array}[i];
  return sum;
}`;

export const LENS_MATH_GLSL = `
${horner('lensDist', 'u_lensDist', DISTORTION_TERMS)}
${horner('lensRed', 'u_lensRed', CA_TERMS)}
${horner('lensBlue', 'u_lensBlue', CA_TERMS)}
${horner('lensVigNum', 'u_lensVigNum', VIGNETTE_NUMERATOR_TERMS)}
${horner('lensVigDen', 'u_lensVigDen', VIGNETTE_DENOMINATOR_TERMS)}

// Corrected-frame position to the recorded position of green; qOut is the radius CA is a function of
// when the profile gives it at the output radius.
vec2 lensRecorded(vec2 p, out float qOut) {
  qOut = 0.0;
  if (u_lensGeometry == 0) return p;
  if (u_lensManual != 0.0) {
    vec2 d = p - u_lensFrame.xy;
    float r = length(d) / u_lensFrame.z;
    p = u_lensFrame.xy + d * (1.0 + u_lensManual * (1.0 - r * r));
  }
  vec2 d = p - u_lensCentre;
  if (u_lensHasCa == 1) qOut = length(d) / u_lensCaUnit;
  if (u_lensHasDist == 1) p = u_lensCentre + d * lensDist(length(d) / u_lensDistUnit);
  return p;
}

vec3 fetchCam(vec2 pos) {
  pos = clamp(pos, vec2(0.0), u_srcSize);
  if (u_nearest == 1) return texelFetch(u_image, ivec2(pos - u_srcOrigin), 0).rgb;
  return texture(u_image, (pos - u_srcOrigin) / u_srcTexSize).rgb;
}

float lensGainAt(vec2 rec) {
  float gain = 1.0;
  if (u_lensHasVig == 1) {
    float v = length(rec - u_lensCentre) / u_lensVigUnit;
    float ratio = lensVigNum(v) / max(lensVigDen(v), 1e-4);
    gain = u_lensVigExp == 1.0 ? ratio : pow(max(ratio, 1e-4), u_lensVigExp);
  }
  if (u_lensHasManualVig == 1) {
    float r = length(rec - u_lensFrame.xy) / u_lensFrame.z;
    float t = pow(r, u_lensManualVig.z);
    gain *= exp(u_lensManualVig.x * u_lensManualVig.y * t / (1.0 + u_lensManualVig.w * t));
  }
  return gain;
}

// The camera RGB at the recorded position, with red and blue displaced by the lateral CA, and the
// vignetting gain for that position.
vec3 lensCam(vec2 rec, float qOut, out float gain) {
  gain = u_lensGain == 1 ? lensGainAt(rec) : 1.0;
  if (u_lensHasCa == 0) return fetchCam(rec);
  vec2 d = rec - u_lensCentre;
  float q = u_lensCaAtSource == 1 ? length(d) / u_lensCaUnit : qOut;
  return vec3(
    fetchCam(u_lensCentre + d * lensRed(q)).r,
    fetchCam(rec).g,
    fetchCam(u_lensCentre + d * lensBlue(q)).b
  );
}
`;
