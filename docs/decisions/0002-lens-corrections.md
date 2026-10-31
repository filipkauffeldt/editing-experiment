# 0002 Lens corrections

- Status: accepted
- Scope: where distortion, lateral CA and vignetting data come from and how it is applied.

## Context

Question: where do distortion, lateral CA and vignetting data for Nikon Z lenses come from, with
GPL-3.0-compatible licensing and the best result?

- **RAWmakase** (MIT) reads the correction the camera stores in every Nikon Z NEF and applies
  it by default, and treats the Lensfun database as an optional download that is never applied
  unasked. Its documentation (`docs/lens-corrections.md` in the RAWmakase repository) compares
  the Nikon records with Adobe's own
  DNG output on 101 samples: the geometry agrees within 0.4 px, so Adobe is not needed.
- **Nikon embedded data.** Tag `0xC7D5` of the raw SubIFD (ExifTool's `NikonNEFInfo`, a small
  TIFF after a `Nikon\0` header) holds, in its entries 5 to 8, the distortion polynomial, the
  vignetting polynomial, red/blue lateral CA and the optical centre of the exact lens, focal
  length and focus of the shot. ExifTool only exposes entries 7 to 9 as unknown binary tags and
  never decodes the rest, so `@ee/metadata` reads the SubIFD itself. ExifTool's
  `DistortionCorrection` (`On (Required)` / `On (Optional)` / `Off`) is the same mode byte.
  Z bodies and the lenses Nikon corrects in software (e.g. 24-70mm f/4 S, 24-200mm, DX 16-50mm)
  are marked *Required*: Camera Raw always applies the correction to those.
- **Lensfun** (database CC BY-SA 3.0, library LGPL-3): the XML calibrations are community
  measurements of lens models in focal length steps: poly3/poly5/ptlens distortion, TCA and
  `pa` vignetting at focal length, aperture and distance. 36 Nikon Z lenses and about 230 Nikon
  F lenses are in it, so it covers lenses and adapters (FTZ) with no embedded data and gives the
  user a choice. It cannot be better than the camera's own per-shot data where that exists.

## Decision

Two sources share one radial model, evaluated in the shader:

1. *Built-in* (Nikon NEF) is the automatic choice. It needs no database, it is exact for the
   shot, and it follows the camera's Required/Optional flag (Required is on without the user
   asking; Optional waits for *Enable Profile Corrections*).
2. *Lensfun* is the profile for everything else and the manual override in the profile select.
   A pruned copy (Nikon Z mount with every maker, and Nikon's own F-mount lenses; 0.3 MB, 74 kB
   gzipped) is vendored as `packages/develop-gl/data/lensfun.json` with the licence text and
   regenerated with `pnpm update-lensfun`. Only the *model maths* is ported (written from the
   documented formulas; no Lensfun code and no library). It is shipped as separate data under its
   own licence, not linked or merged into GPL code; the README attributes it.

Adobe `.lcp` profiles are not read. `crs:LensProfileName` / `LensProfileFilename` are parsed and
preserved but never applied or written for our own choice (our choice is `ee:LensProfile`), so
Lightroom does not try to find an Adobe profile of a Lensfun name.


## Consequences

### Implementation

Code is in `packages/develop-gl/src/lens` (maths, matching, measurement), `src/glsl/lens.ts`
(shader mirror) and `packages/metadata/src/lens.ts` (the lens facts and the Nikon records).

- **Where in the order.** Geometry is a resampling step, so it is the first thing the pipeline
  does and everything after it works in the corrected frame: the crop, straighten and
  `renderView` mappings produce a corrected-frame position, the lens map takes it to the recorded
  position, and that is what the base pass (and the single develop pass) fetches. Noise
  reduction, Texture, Clarity, Dehaze (including its 512 px measurement copy, rendered through the
  same fetch), sharpening, the post-crop vignette and grain all see the corrected picture, so
  none of them needs to know about the lens. A lens correction keeps the picture's size and
  coordinate frame, which is why the stored crop (`crs:Crop*`) stays valid: it is a rectangle in
  the corrected frame, as in Lightroom. The out-of-frame rule is unchanged (the edge repeats), and
  profile corrections zoom in just enough (`fitScale`) never to pull in empty canvas.
- **One radial model.** Everything is reduced to polynomials about an optical centre
  (`lens/model.ts`): green's recorded radius over the corrected radius, red's and blue's radius
  over green's, and a vignetting gain `numerator(v) / denominator(v)`. Nikon's records and
  Lensfun's poly3, poly5, ptlens, TCA and `pa` models all convert to it (Lensfun with the
  documented normalisation to half the short edge of the calibrated frame, scaled by the crop
  factor; the focal length interpolation is Lensfun's cubic Hermite step, vignetting its
  inverse-distance weighting over focal length, 4/f-number and 1/distance). The manual Distortion
  (about the image centre, `r (1 + k (1 - r^2))`, k = 0.4/0.5 x amount) and the manual lens
  vignette (`ln gain = amount c r^p / (1 + k r^p)`, Midpoint moving c, p and k) are RAWmakase's
  fits of Camera Raw 18.7 and apply before and after the profile respectively. The profile
  Distortion amount blends `1 + A (g - 1)`, the Vignetting amount is an exponent on the gain.
- **Profile choice.** `LensProfileEnable` absent means on only for a lens whose NEF says the
  correction is required (Camera Raw applies those whatever the user chose); `false` turns it off.
  `LensProfileChoice` (`ee:LensProfile`) is empty for automatic (built-in data, else the best
  Lensfun match for `LensModel` on the camera's mount and format), `builtin`, or
  `lensfun:<maker>|<model>|<crop>`. `crs:LensProfileName`/`Filename` are read and kept but never
  applied.
- **Lens facts travel in the linear image header** (`LinearImageHeader.lens`, filled by
  `AppResources` with `readLensShot`), so the canvas, the edited previews and the export workers
  resolve the same lens with no further lookups. `resolveUniforms` resolves it with the settings.
- **Tiles.** Source textures get an 8 px border (`LENS_TILE_BORDER`) so a displaced red or blue
  sample stays inside its tile; a tile draws the fragments whose green recorded position it owns.
- **Remove Chromatic Aberration** (`lens/auto-ca.ts`) measures the photo, replaces the profile's
  CA, and is cached per buffer. About 800 edge tiles of 1/90 of the long edge, radial shift search
  and Gauss-Newton on z-scored samples, a Tukey-weighted fit of `1 + a + b q + c q^2`; nothing is
  applied below 0.08 px at the corner (on 6000 px). The renderer keeps a reference to the sample
  buffer for it.
- **Defringe** is the RAWmakase fit of Camera Raw: Oklab chroma reduction in the purple (0.875)
  and green (0.46) hue windows; the spatial part (more next to edges) is not reproduced.
- **Retouch.** Mosaic shapes are stored in the recorded (uncorrected) picture. The mosaic is
  applied to the rendered pixels, after the lens geometry and the crop, with the shapes moved first
  into the corrected frame by `correctedShapes` (each outline cut into <= 8 px pieces, mapped
  through the exact inverse of the lens map, pushed out 1.5 px; points the corrected frame no longer
  shows are clamped along their ray) and then into the cropped output by `cropMosaicOp` (a
  straightened rectangle becomes a polygon). `composeDevelopedRgba` does this for the export, the
  edited previews and the canvas preview alike. No resampling happens after the mosaic, so blocks
  stay exactly constant. While a retouch session is open the canvas shows
  the picture without the lens geometry (`withoutLensGeometry`), so a drawn selection is already
  in the stored frame. A test on pixels proves a 3 px checker "face" in a corner, where a strong
  barrel correction moves it by 20 px, is fully covered, and shows that the unmapped shape would
  not be.

- **Detected faces.** Detection reads the camera's embedded preview, which Nikon corrects
  in-camera whenever its distortion control was on, which is exactly when the file has a built-in
  profile (`previewGeometry`). A box found there is in the *corrected* frame, so before it is stored
  it is padded and taken, as a densified outline, through the lens map (corrected to recorded,
  `previewShapesToRecorded`); the search region drawn on the recorded picture goes the other way
  (`recordedRegionToPreview`). Both are applied where a face becomes a shape
  (`faceStoredShape` / `detectionRegion` in `renderer/retouch-geometry.ts`), so the overlay, the live
  preview and the commit agree. A pixel test with a strong barrel lens and a corner face covers the
  chain box, stored shape and export, with a control showing that the unmapped box leaves the face
  visible; `camera-preview-geometry.test.ts` checks on the Z 6II and Z 30 fixtures that the
  preview really is the corrected picture (corner edge correlation rises by more than 0.05 with the
  camera's correction on).

**Verifying against Lightroom** (no Lightroom render is committed yet): shoot a straight-line
architectural scene (a building front, a door frame, a tiled wall) with the NIKKOR Z 24-70mm f/4 S
at 24 mm; export a full-size JPEG from Lightroom Classic with *Enable Profile Corrections* on (and
*Remove Chromatic Aberration* if wanted), and one from this app with the same file (the camera's
profile is automatic, and on for this lens). Overlay the two (difference blend) or compare the
positions of a long straight edge near a corner; the Nikon records match Adobe's own conversion to
within about 0.4 px at full size in RAWmakase's comparison. A crop fixture like the existing one can
be added from that pair.

Known limitations: fisheye and other non-rectilinear Lensfun lenses are not offered; Adobe
`.lcp` profiles are not read; the focus distance for Lensfun vignetting is taken from the file
or 1000 m; manual positive distortion repeats the picture's edge where it pulls in canvas
instead of showing white; the Nikon records were checked on three CC0 NEFs (a lens the camera
requires, one it makes optional, a DX zoom) for plausibility, not against Adobe's output.
