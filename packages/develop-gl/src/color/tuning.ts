/**
 * Tunable numbers for the per-pixel colour and effects stages (Color Mixer,
 * Color Grading, Calibration, parametric curve, vignette and grain).
 *
 * The maths follows RAWmakase (https://github.com/pch/rawmakase, MIT) where a
 * measured model is small enough to port (calibration, vignette, grain). The
 * HSL mixer and grading use smooth analytic band/region weights instead of
 * RAWmakase's measured binary tables, so they are an approximation of Camera
 * Raw rather than a byte-for-byte match.
 */
export const COLOR_TUNING = {
  /** Lightroom band centres in degrees, in `ColorMixerBand` order. */
  bandHues: [0, 30, 60, 120, 180, 240, 280, 320],
  /** Half-width of a band's smooth hue weight, in degrees. Adjacent bands overlap. */
  bandHalfWidth: 40,
  /** Hue shift at slider ±100 for the band at the centre, in degrees. */
  hslHueDegrees: 30,
  /** Saturation factor change at slider ±100 (1 + 0.8 = 1.8x). */
  hslSaturationStrength: 0.8,
  /** Value factor change at slider ±100 (1 + 0.5 = 1.5x). */
  hslLuminanceStrength: 0.5,
  /** Below this HSV saturation a pixel is neutral and no band touches it. */
  neutralSaturation: { from: 0.03, to: 0.15 },

  /**
   * Color Grading tonal regions. Centres are encoded luma; Balance moves them
   * and Blending widens their gaussian width.
   */
  gradeCentres: { shadows: 0.16, midtones: 0.5, highlights: 0.84 },
  gradeWidth: 0.15,
  gradeWidthPerBlending: 0.16,
  /** Balance +1 moves shadows up and highlights down by this much. */
  gradeBalanceShift: 0.16,
  /** Channel gain from a fully saturated region tint at Saturation 100. */
  gradeTintStrength: 0.55,
  /** Encoded luminance gain from the region Luminance slider at ±100. */
  gradeLuminanceStrength: 0.45,

  /**
   * Parametric curve: a smooth bump per region in gamma-2.2 encoded space,
   * clipped to each region's span. Amplitudes are in encoded units at ±100.
   */
  parametricGamma: 2.2,
  parametricStrength: { shadows: 0.22, darks: 0.16, lights: 0.16, highlights: 0.22 },

  /** Post-crop vignette, ported from RAWmakase's `effects/vignette.rs`. */
  vignette: {
    /** Feather 100 makes the mask linear; Feather 0 a hard edge. */
    featherFloor: 0.005,
    /** Roundness scale towards a circle (positive) or a rectangle (negative). */
    roundnessCircle: 0.92,
    roundnessRectangle: 0.95,
    /** Midpoint 50 means half strength at the frame edge. */
    midpointScale: 1.27,
    /** Highlight Priority's protection ramp on linear luminance. */
    highlightProtect: { from: 0.198, to: 1.108, exponent: 1.43 },
    /** Darkening paint strength and its falloff shape. */
    paintDarken: 0.97,
    colorPriorityLighten: 0.61,
    highlightPriorityLighten: 1.1,
    colorPriorityMix: { base: 0.13, perAmount: 0.19 },
    sceneWhiteEv: 3.5,
  },

  /** Grain, ported from RAWmakase's `effects/grain.rs`. */
  grain: {
    referenceEdge: 6000,
    widthBase: 0.1555,
    widthPerSize: 3.627,
    roughness: [0, 0.5, 1],
    roughnessWidth: [1.1487, 1, 1.4675],
    roughnessCoarse: [0.1546, 0.1132, 0.2058],
    roughnessFine: [1.8644, 1, 1],
    fine: 0.3538,
    fineFade: 0.7055,
    luminance: [0, 0.023, 0.156, 0.41, 0.62, 0.8, 0.91, 0.964, 1],
    luminanceGain: [0, 0.5, 1.14, 1.08, 1, 0.94, 0.86, 0.61, 0.3],
  },
} as const;
