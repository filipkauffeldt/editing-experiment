/**
 * Every tunable number of the develop pipeline lives here, and nowhere else.
 * The CPU reference (`ops.ts`) and the GLSL (`glsl.ts`, which interpolates this
 * object into the shader source) read the same values, so recalibrating
 * against Lightroom means editing this file only.
 *
 * Slider values are normalised to -1..1 (`slider / 100`) before they get here.
 */
export const TUNING = {
  /** Linear luminance treated as mid-grey; contrast pivots around its sRGB-encoded value. */
  midGrey: 0.18,
  /** Luminance below this is clamped before the tone maths, which bounds the gain applied to near-black noise. */
  luminanceFloor: 1e-4,

  /** Rec.709 luminance weights (linear light, and reused on encoded values as "luma"). */
  luma: [0.2126, 0.7152, 0.0722],

  /**
   * Raw highlight handling: a raw channel at or above 1.0 (sensor white) is
   * clipped, and pixels fade to neutral over the last stretch below it, from
   * `clipKnee` to 1.0 in the largest raw channel.
   */
  clipKnee: 0.95,

  /** Contrast: curve exponent is `2^(contrastExponent * contrast)`. */
  contrastExponent: 0.6,

  /** Highlights: maximum change in stops at slider +-100, and the encoded-luminance ramp of its mask. */
  highlightsStops: 1.5,
  highlightsMask: { from: 0.35, to: 1.0 },
  /** Shadows: maximum change in stops at +-100; the mask is 1 at black and falls to 0 at `to`. */
  shadowsStops: 2.0,
  shadowsMask: { from: 0.0, to: 0.65 },

  /** Whites/Blacks: shift of the encoded end point at +-100 and the falloff exponent of their weights. */
  whitesStrength: 0.12,
  blacksStrength: 0.12,
  endpointFalloff: 3,

  /**
   * Highlight roll-off, applied per channel to linear light just before the sRGB
   * OETF: identity up to `knee`, then a smooth shoulder that reaches exactly 1 at
   * `white` (scene-linear, 1 = sensor white) so nothing hard clips on the way.
   */
  shoulderKnee: 0.9,
  shoulderWhite: 2.0,

  /** Vibrance: hue (degrees) and half-width of the skin-ish range, and how much it damps the boost. */
  skinHue: 25,
  skinHueWidth: 30,
  skinProtection: 0.6,

  /** Resolution of the tone curve table (per channel). */
  curveLutSize: 1024,
} as const;
