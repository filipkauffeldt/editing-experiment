# 0003 Neighbourhood operations

- Status: accepted
- Scope: Texture, Clarity, Dehaze, sharpening and noise reduction.

## Context

Texture, Clarity, Dehaze, sharpening and noise reduction look at a pixel's
neighbours, so they are separate passes around that chain (`src/neighbourhood`).
Their maths is ported from RAWmakase (MIT; see the README notice) and its fits of
Camera Raw; constants are in `src/neighbourhood/tuning.ts`. Order:

```
source -> white balance, matrix, calibration (Exposure 0)   base pass
       -> noise reduction  (luminance, colour)                sqrt-space pyramid
       -> Texture, Clarity (gain on log luminance), Dehaze    analysis pyramid + fields
       -> exposure                                            (applied with the local gain)
       -> tone, shoulder, OETF, curves, mixer, grading        the per-pixel chain above
       -> sharpening                                          unsharp mask of encoded luma
       -> post-crop vignette, grain                           last, so they are not sharpened
```

Why this order, as in Lightroom and RAWmakase: noise reduction works on the
linear image before anything amplifies the noise; Texture, Clarity and Dehaze are
scene-referred (they are gains on linear light, before the tone curve and the
shoulder); sharpening is on the encoded image, so it sharpens what is
displayed and halos are not tone-mapped, but before vignette and grain so the
grain is not sharpened. A photo with none of these set uses the
single develop pass exactly as before.


## Decision

- **Pyramid.** Level `k+1` is the 2x2 box mean of level `k`; levels are sampled
  bilinearly at fractional levels (a "blur" of any size). The analysis plane is
  log2 luminance. Texture is six band-passes `G(l) - G(l+1)` compressed where
  strong; Clarity is four edge-aware blurs (a five-tap, range-weighted sample of the
  pyramid, standing in for RAWmakase's bilateral grid) combined with weights read at
  the local base level relative to the photo's key; noise reduction thresholds the
  bands of a five-level pyramid of `sqrt(Y), c1, c2`.
- **Resolution consistency.** Radii are in pixels of the full-resolution photo
  (`sourceWidth` in the linear header). With `s` output pixels per full-resolution
  pixel, Texture's band `l` sits at pyramid level `log2(s) + l`, sharpening's sigma is
  `sigma * s`, and Clarity's scales are fractions of the frame's long edge. A 2560 px
  preview and a 6048 px export therefore look the same (a browser test compares
  them). Noise reduction thresholds come from the noise measured in the image
  itself (the RMS of the finest band in the smoothest 10% of 8x8 blocks), so they
  adapt to the size.
- **Dehaze** needs the photo as a whole: a 512 px measurement copy at Exposure 0 is
  rendered once per image and white balance and read back; the CPU computes the dark
  channel airlight and the guided-filter haze density (RAWmakase's model) and the
  density is sampled by source position. Negative Dehaze blends towards the airlight
  (RAWmakase fits a per-photo veil; this is a plain one).
- **Tiles.** Each export tile is rendered with a halo around its core
  (`HALO` in `pipeline.ts`: 160 px for noise reduction, 32 for local contrast,
  16 for sharpening, summed and rounded up to a multiple of 32) that is thrown away.
  Cores start on multiples of 32, so a tile's pyramid grid is the whole image's.
  Pyramid levels above 3 and the noise measurement are global: one extra render of
  the output at 1/8 size (64 taps per pixel) and one probe pass per tile, so no tile
  sees a different blur or noise level than its neighbour. Tests compare a tiled and
  an untiled render, also with a split source texture, including a check within two
  pixels of every tile edge.
- **Caching for live preview.** The base image, noise reduction, pyramid and the
  Texture/Clarity fields (which depend on neither the slider amounts nor the
  exposure, since the stages work on ratios and log values) are kept between
  `render()` calls with the same image, crop, output size, white balance and noise
  reduction settings. Dragging Texture, Clarity, Dehaze, exposure, tone or
  sharpening runs only the combine, develop and sharpening passes.
- **CPU parity.** `renderCpu` runs the same stages whole-image. The GPU differs
  by half-float intermediates and 8-bit bilinear weights: at most 1 level of 255 on
  the test scenes (the test allows 3). The measurement copy is sampled with the same
  4x4 taps on both sides.
- **Crop mode** (`renderView`) runs the same pipeline and cached stages as the normal
  view; only the mapping (the image turned under the frame) and the last step (empty
  canvas, dimmed outside the frame, vignette and grain relative to the frame) differ. The
  cache only holds while the mapping does not move, so panning or rotating re-runs the
  stages, as a crop change does in the normal view. Noise is measured on blocks that lie
  on the photo, not on the empty canvas around it.

## Consequences

The passes share the tiled, cached pipeline described above. Tests cover tiled versus untiled renders, resolution consistency and CPU/GPU parity in `packages/develop-gl/test`.
