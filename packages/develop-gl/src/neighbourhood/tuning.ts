/**
 * Tunables of the neighbourhood ops (Texture, Clarity, Dehaze, sharpening and
 * noise reduction). Like `../tuning.ts`, the CPU reference and the GLSL both
 * read these numbers.
 *
 * Most of the shape of these ops, and the fitted tables below, are ported from
 * RAWmakase (https://github.com/pch/rawmakase, MIT, see
 * `third_party/rawmakase/LICENSE`): `texture.rs`, `clarity.rs`,
 * `clarity_data.rs`, `sharpening.rs`, `luminance_noise.rs`, `color_noise.rs`
 * and the Dehaze section of `docs/scene-tone-stage.md`. RAWmakase fitted them
 * to Camera Raw 18.7 renders. Where we simplify (the pyramid, the bilateral
 * blur, the noise estimate) the comment says so.
 */

/** Pyramid levels above the image itself that are ever sampled (0 = the image, up to this). */
export const MAX_LEVEL = 8;

/** Levels `1..LOCAL_LEVELS` are built per tile; coarser ones come from the whole output (see `ARCHITECTURE.md`). */
export const LOCAL_LEVELS = 3;

/**
 * Tiles start on multiples of this many output pixels, so a tile's pyramid grid
 * is the whole image's grid (it is `2^NR_LEVELS`, the deepest local level).
 */
export const TILE_ALIGN = 32;

/**
 * Texture (RAWmakase `texture.rs`): a band-pass detail of the log luminance
 * over six pyramid bands (band `l` is about `2^l` full-resolution pixels), each
 * compressed where it is strong (`band / (1 + (band / threshold)^2)`) and
 * weighted, then scaled by a strength Texture sets. RAWmakase runs this per
 * colour channel; we run it on luminance and apply the gain to all channels.
 */
export const TEXTURE = {
  weights: [1.402, 0.665, 1.571, 0.583, 0, 0.072],
  thresholds: [0.506, 0.098, 0.167, 0.192, 0.135, 0.176],
  amounts: [-1, -0.5, 0, 0.25, 0.5, 1],
  strength: [-0.752, -0.499, 0, 0.334, 0.546, 0.852],
} as const;

const KNOTS = 9;

/**
 * Clarity (RAWmakase `clarity.rs`): a log2 gain of the detail at four blur
 * scales, weighted by the local base level relative to the photo's brightest
 * levels. Fitted to Camera Raw renders at -100, -50, +50 and +100; scale-major
 * rows, `KNOTS` columns from `knotLow` to `knotHigh`.
 */
export const CLARITY = {
  /** Blur sigmas as a fraction of the full frame's long edge. */
  scales: [0.004, 0.015, 0.05, 0.15],
  /** Range sigma of the edge-aware blur, in log2 units. */
  range: 2,
  knots: KNOTS,
  knotLow: -8,
  knotHigh: 0.5,
  /**
   * Gaussian sigma, in pixels of the blur's pyramid level, of one blur: a bilinear
   * level sample (box 0.29 and tent 0.41, in quadrature) combined with the spread of
   * `taps`. Turns a target sigma into a fractional pyramid level.
   */
  sigmaPerLevel: 0.92,
  /** Largest log2 change of one pixel, a safety net where the blur is not edge aware enough. */
  maxGain: 2.5,
  weightsMinus100: [
    [-0.0272, -0.1927, -0.0764, -0.0689, 0.0068, 0.0567, -0.0718, 0.0036, -0.01],
    [-0.0118, -0.1986, -0.1022, -0.3007, -0.5374, -0.5815, -0.583, -0.4256, -0.0465],
    [0.0353, 0.0537, 0.0165, 0.0106, 0.0613, -0.0626, -0.0075, 0.023, 0.0015],
    [-0.0129, -0.0107, -0.0058, -0.0347, -0.0396, 0.0305, 0.0223, 0.0098, -0.0591],
  ],
  weightsMinus50: [
    [-0.0168, -0.1137, -0.0451, -0.049, 0.0023, 0.033, -0.0431, 0.002, -0.0053],
    [-0.0064, -0.1204, -0.0596, -0.1772, -0.3246, -0.3499, -0.3455, -0.2508, -0.0234],
    [0.0213, 0.0354, 0.0092, 0.0078, 0.0372, -0.0391, -0.0068, 0.0141, 0.0001],
    [-0.0078, -0.0079, -0.0029, -0.0225, -0.0251, 0.0186, 0.0153, 0.0058, -0.0346],
  ],
  weightsPlus50: [
    [0.2292, 0.0713, 0.207, 0.1321, -0.0268, -0.0161, -0.0212, 0.0981, 0.0086],
    [0.0056, 0.4016, 0.226, 0.3029, 0.2107, 0.1972, 0.1403, 0.0193, 0.0556],
    [0.0158, 0.1688, -0.0357, -0.0904, 0.0172, -0.2251, 0.0159, 0.2423, 0.1087],
    [0.3042, 0.2691, 0.4679, 0.397, 0.3296, 0.4703, 0.2079, -0.1511, -0.0771],
  ],
  weightsPlus100: [
    [0.5227, 0.1151, 0.3593, 0.2642, -0.0568, -0.034, -0.0428, 0.1978, 0.0093],
    [0.1186, 0.7805, 0.4183, 0.6086, 0.4204, 0.3962, 0.2819, 0.0322, 0.0939],
    [0.0989, 0.299, 0.0878, -0.2082, 0.049, -0.4586, 0.0347, 0.4822, 0.2054],
    [0.5386, 0.5871, 0.784, 0.8144, 0.6365, 0.944, 0.4094, -0.3026, -0.1482],
  ],
  /**
   * Spatial taps of our edge-aware blur: offsets in units of the blur level's pixel
   * size and their weights. Each is also weighted by `1 / (1 + (d / range)^2)` for
   * the log2 difference `d` to the centre (a Cauchy range kernel). RAWmakase uses
   * a bilateral grid; this is a five-tap stand-in that fits a fragment shader.
   */
  taps: [
    { x: 0, y: 0, w: 0.4 },
    { x: 1, y: 0, w: 0.15 },
    { x: -1, y: 0, w: 0.15 },
    { x: 0, y: 1, w: 0.15 },
    { x: 0, y: -1, w: 0.15 },
  ],
} as const;

/**
 * Dehaze, from RAWmakase's `scene-tone-stage.md`. Positive: a dark channel
 * prior haze removal, `J = (p - A) / t + A` with `t = max(1 - omega * density,
 * transmissionFloor)`, the density from a measurement copy of the whole photo.
 * Negative: RAWmakase fits Camera Raw's veil per photo; we blend towards the
 * airlight instead (a plain veil, `veilStrength` at -100).
 */
export const DEHAZE = {
  /** Slider (0..1) to `omega` knots, linear in between. */
  omegaAmounts: [0, 0.2, 0.4, 1],
  omega: [0, 0.3, 0.45, 0.9],
  transmissionFloor: 0.3,
  /** Dark channel window radius as a fraction of the measurement copy's long edge (at least 1 px). */
  windowFraction: 0.005,
  guidedEps: 0.01,
  airlightPercentile: 0.99,
  /** Share of the copy's brightest log luminances that defines the clarity key level. */
  keyPercentiles: [0.999, 0.99],
  keyWeights: [0.25, 0.75],
  /** Channels never fall below this share of the pixel scaled by the luminance change. */
  channelFloor: 0.5,
  /** Long edge of the measurement copy is at most this. */
  copyEdge: 512,
  /** Negative Dehaze: blend towards the airlight by this much at -100. */
  veilStrength: 0.35,
} as const;

/**
 * Sharpening (RAWmakase `sharpening.rs`): an unsharp mask of encoded luminance
 * with the halo at strong edges held back, Detail scaling strength, and Masking
 * fading out the weakest detail. All tables are by slider value.
 */
export const SHARPEN = {
  radius: [0.5, 0.8, 1, 1.5, 2, 3],
  radiusSigma: [0.705, 0.793, 1, 1.101, 1.342, 1.806],
  radiusGain: [1.115, 1.214, 1, 1.111, 0.906, 0.608],
  /** Detail and Masking, 0..1. */
  unit: [0, 0.25, 0.5, 0.75, 1],
  detailGain: [0.3179, 1, 1.538, 1.848, 2.084],
  detailHalo: [1.578, 1, 0.99, 0.986, 0.979],
  maskingThreshold: [0, 0.012, 0.09, 0.138, 0.2],
  /** Strength per Amount at Radius 1 and Detail 25 (Amount 1 is Lightroom's 150). */
  gain: 4.872,
  halo: 0.0863,
  /** Dark halos relative to light ones. */
  dark: 0.574,
  /** The Gaussian is cut at this many sigmas, and never wider than `maxRadius` taps each side. */
  cutoffSigmas: 3,
  maxRadius: 16,
  /** Lightroom's `Sharpness` slider maximum, so Amount = Sharpness / this. */
  sliderMax: 150,
} as const;

/** Noise reduction, in square-root space (`Y = (r + 2g + b) / 4`, `c1 = r - g`, `c2 = b - g`). */
export const DENOISE = {
  /** Bands `0..LEVELS-1` are thresholded; the pyramid has `LEVELS + 1` levels. */
  levels: 5,
  /** Luminance: `threshold = noise * 3.8 * amount^1.3 * detailFactor * contrastFactor`. */
  luma: { scale: 3.8, amountPower: 1.3, detailFine: 1.5, detailCoarse: 0.5, contrastCoarse: 0.6 },
  /** Chroma thresholds, in multiples of each band's noise, at the amounts Camera Raw rendered (finest first). */
  chroma: {
    amounts: [0.1, 0.25, 0.5, 1],
    thresholds: [
      [7.29, 7.08, 6.83, 6.8],
      [1.73, 3.34, 3.92, 4.03],
      [1.86, 4.29, 5.98, 5.98],
      [1.29, 2.74, 3.34, 3.35],
      [1.29, 2.74, 3.34, 3.35],
    ],
    /** Detail's and Smoothness's factors at 0, 25, 50, 75 and 100. */
    detail: [
      [1.2, 1.11, 1, 0.58, 0.26],
      [1.13, 1.07, 1, 0.73, 0.54],
      [0.91, 0.93, 1, 1.16, 1.3],
      [0.95, 0.95, 1, 1.06, 1.4],
      [0.95, 0.95, 1, 1.06, 1.4],
    ],
    smoothness: [
      [1, 1, 1, 1, 1],
      [0.96, 0.97, 1, 0.97, 0.98],
      [0.53, 0.8, 1, 1.14, 1.21],
      [0.28, 0.61, 1, 1.63, 2.12],
      [0.28, 0.61, 1, 1.63, 2.12],
    ],
    referenceNoise: 0.0075,
    noiseExponent: [0.16, 0.05, 0.1, 0.6, 0.6],
    /** Chroma gain is `1 / (1 + (threshold^2 / energy)^steepness)`. */
    steepness: 3,
  },
  /**
   * Noise of band `l` is the finest band's times this to the `l`. RAWmakase
   * measures every band and falls back to 0.6 per level for bands it cannot
   * measure; we always use the fallback so one measurement suffices.
   */
  coarserNoise: 0.6,
  /** The noise is the RMS of the band-0 detail in the smoothest 10% of 8x8 blocks. */
  block: 8,
  blockPercentile: 0.1,
  /** At most this many blocks per axis are measured, spread evenly over the output. */
  maxBlocksX: 64,
  maxBlocksY: 48,
  /** Luminance gain is `1 / (1 + (threshold^2 / energy)^2)` over a 3x3 mean of band energy. */
  lumaSteepness: 2,
} as const;
