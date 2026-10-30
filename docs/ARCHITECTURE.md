# Architecture

## PoC demo (definition of done)

1. Two local folders (simulating cards) and one FTP server (simulating a hosted
   server) are ingested **in parallel**, each in filename order, with rename
   and a Photo Mechanic metadata template applied; XMP sidecars are written and
   thumbnails appear live in the film strip.
2. Caption a photo using code replacements and `{variables}`.
3. Apply a Lightroom preset (`.xmp`) and adjust exposure, white balance
   (temp/tint), contrast, highlights, shadows, whites, blacks, vibrance and
   saturation with live GPU preview.
4. Select an area, run face detection inside it, mosaic the detected faces.
5. **Next & send** renders a JPEG at the active export preset's output size with
   metadata and no leaked original thumbnail into the preset's local folder,
   uploads the exported file to a target FTP/SFTP server, and advances to the
   next photo.

## Layout

```
apps/desktop          Electron app (electron-vite): main, preload, renderer (React)
crates/core           Rust napi-rs addon: vendored LibRaw, previews, raw decode, JPEG decode/resize/encode
packages/contracts    Shared TS types + IPC channel definitions (no runtime deps)
packages/metadata     ExifTool service, PM templates, code replacements, variables, sidecars
packages/ingest       Sources (folder/card, FTP/SFTP poller), copy workers, rename, verify
packages/export       JPEG encode (@ee/core), thumbnail stripping, upload queue (FTP/FTPS/SFTP)
packages/develop-gl   WebGL2 develop pipeline, crs: parameter model, LR preset parser
packages/retouch      Selections, mosaic op, YuNet face detection (onnxruntime)
scripts/              fetch-fixtures, screenshot helpers
```

## Processes

```
Renderer (React)  ── typed IPC (contracts) ──>  Main (thin: windows, routing)
   │  WebGL2 develop preview + export render                 │
   │  images via app:// protocol                            ├─> Utility process "jobs":
   │                                                        │     ingest, metadata (ExifTool),
   │                                                        │     export encode, upload queue
   │                                                        └─> crates/core (napi) loaded
   │                                                              in the utility process
```

- The main process never does heavy work.
- `app://thumb/<photoId>`, `app://preview/<photoId>` serve cached JPEGs;
  `app://linear/<photoId>?maxEdge=N` serves the decoded linear image
  (see "Linear image format"). JPEGs are served as linear sRGB with an identity
  camera matrix so develop preview and export renders work for them too.
- SQLite (built-in `node:sqlite`, `DatabaseSync`; no native module to rebuild per
  Electron ABI) in the utility process: photo index, source state
  (seen remote files), upload queue. It is a cache: XMP sidecars are the
  source of truth for metadata and edits.

## Backend (jobs process)

`apps/desktop/src/jobs/backend` implements every `IpcApi` channel outside mock mode. It has no
Electron dependency (`createBackend({ userDataDir, emit, getSecret })`), so integration tests run it
in plain Node. Files under Electron's `userData`:

```
settings.json        sources, destinations, ingest options, export presets, active preset
index.sqlite         photo index (cache; sidecars are the source of truth)
seen.sqlite          files already ingested per source
uploads.sqlite       upload queue
export-jobs.json     resumable export batches (queued photos survive a restart)
exported-files.json  paths the app exported; the only targets `overwrite` may replace
presets/*.json       imported develop presets
credentials.json     written by main only: ciphertext from safeStorage
cache/{thumb,preview,linear}   disposable (see "Edited thumbnails and previews")
exports/             default exportRoot (presets choose folders below it)
```

- Ingest: `@ee/ingest` with the `{variable}` expander from `@ee/metadata` and a per-file hook that reads
  camera data, caches a 2560px preview and a 320px thumbnail, applies the PM template, indexes the
  photo and emits `photos:added`. Ingest awaits the hook per source, so photos appear in copy order.
- `app://thumb|preview` are cached JPEGs. `app://linear/<id>?maxEdge=N` is decoded in the jobs process
  (f16 for raws, f32 for JPEGs), written to `cache/linear` (small LRU) and streamed from
  there by main, with the `LinearImageHeader` in `x-ee-linear-image`. Main only streams
  files below `cache/`.
- Secrets: `credentials:set/remove` run in main (`safeStorage`, no plaintext fallback). The jobs process asks
  for a secret by `credentialRef` over a private `MessagePort` (`shared/secret-port.ts`) when it connects;
  there is no channel that returns a secret to the renderer. An absent/empty `credentialRef` on an FTP
  source or destination means anonymous FTP (user `anonymous`), so demos and tests need no keyring.
- Edits: develop params are the `crs:` block of the sidecar (one develop version per photo), retouch
  versions are `ee:RetouchVersions`. Writes to one photo's sidecar are serialised.
- Exports: an export job owns a list of photos and a preset. The jobs process asks the renderer for
  each export render over `jobs:event` (`export.render`); the renderer replies with
  `export:render` (RGBA over IPC, the same PoC cost as the old finish action). The renderer fetches
  the full-resolution linear source but draws it directly at the preset's output size: the crop's
  pixel size is fitted to `resize` by the shared pure `outputSizeForResize`
  (`@ee/export/output-size`), so only `resize: none` renders at full resolution. The jobs process
  then applies output sharpening (a luminance unsharp mask in `packages/export`), encodes,
  writes metadata, runs `assertNoEmbeddedPreviews`, publishes atomically and only then enqueues the
  exported file for upload. The encoder uses the same size function and skips its resize when the
  render is already the output size. Jobs are persisted in `export-jobs.json`; after a restart the
  current photo is queued again once the renderer calls `export:rendererReady`.
- Export safety: the target is checked against every indexed photo's `path` and `sidecarPath`
  (case-folded on macOS/Windows) and an export never writes over them. `ifExists` defaults to
  `suffix`; `overwrite` only replaces a path recorded in `exported-files.json`. The render request
  carries the ops key (`retouchOpsKey`) the jobs process expects; the renderer echoes the key of the
  ops it applied and the jobs process rejects a stale or mosaic-less render.
- On quit, main asks the jobs process to shut down (stop ingest, close the upload queue, ExifTool and
  the databases) and kills it only after a timeout.

## Edited thumbnails and previews

The film strip and the `app://preview` fallback show a photo as edited: develop
settings, crop/straighten and the newest retouch version's mosaic. The camera's
embedded preview is only made once, at ingest.

- **Render (renderer).** `renderEditedPreview` (`renderer/edited-preview-render.ts`) draws the
  photo from `app://linear?maxEdge=2560` through the export composition (`composeDevelopedRgba`:
  develop, mosaic, then crop/rotate) at a 2560 px preview and a 320 px thumbnail, in render workers.
- **When.** `EditedPreviewScheduler` (`renderer/edited-preview-scheduler.ts`): an edit (slider,
  preset, crop) waits 750 ms for quiet, edits to one photo coalesce, renders run one at a time and
  never block the sliders. A photo with a pending edit keeps its job when the selection moves (it is
  rendered at once). A retouch commit/delete renders ahead of the debounce. A photo with no edits is
  not rendered. Photos the backend reports as `previewStale` (edited in Lightroom before ingest, or
  the app quit mid-debounce) are rendered, throttled, when selected or visible in the film strip.
  The strip reports its visible frames; queued background renders of frames that scrolled away are
  dropped, the selected photo goes first and then the newest frames, and finished jobs are forgotten.
  A retouched photo whose render failed is retried as soon as it is selected.
- **Store (jobs).** `photos:setEditedPreview` carries the RGBA of both sizes, a `revision` and the
  `retouchOps` and develop `params` that were drawn. `EditedPreviews` encodes with `@ee/core`, writes
  `<id>.edited.jpg` beside the camera previews `<id>.jpg` (kept, so reset can revert) plus a
  `<id>.edited.json` marker, bumps `Photo.previewRevision`, clears `previewStale` and emits
  `photos:updated`. It refuses a render with an older revision, with retouch ops that are no longer
  the photo's, with params other than the ones last saved, or for a photo without edits. When the last edit is removed it deletes the edited
  files and the camera preview is served again.
- **Privacy.** The camera preview shows the unretouched image, so `PreviewCache.resolve` serves it
  only for a photo whose newest retouch version has no ops. Otherwise it serves the edited JPEGs if
  they were drawn with exactly the current ops, and a grey placeholder (`no-store`) until they exist.
  `previewRevision` is bumped the moment the retouch ops change, so the `<img>` leaves the old image
  at once.
- **Cache busting.** `appUrl.thumb|preview(id, previewRevision)` adds `?v=<n>`. The canvas does not
  show the cached image under a crop or retouch session, where the stage is the uncropped image.

## Contracts (`packages/contracts`)

Key types (names are binding, fields can grow):

- `PhotoId` (string, UUID minted at ingest), `Photo { id, path, sidecarPath,
  fileName, captureTime?, camera?, sourceId, status, versions, previewRevision?,
  previewStale? }`
- `PhotoStatus { ingest, edited, metadataDiffersFromTemplate, export, upload }`
- `SourceConfig` = `FolderSource | CardSource | FtpSource | SftpSource`
  (`FtpSource` covers FTP and FTPS; remote sources have `pollIntervalMs`,
  `remotePath`, `deleteAfterDownload` default false, `credentialRef`)
- `IngestConfig { sources, destination, backupDestination?, renameTemplate,
  metadataTemplatePath?, codeReplacementPaths[] }`
- `IptcFields` (IPTC Core + common Ext: headline, caption, keywords, byline,
  bylineTitle, credit, source, copyright, city, state, country, countryCode,
  location, event, objectName, jobId, instructions, captionWriter, dateCreated)
- `EditParams` (mirrors Lightroom `crs:` names, e.g. `Exposure2012`,
  `Temperature`, `Tint`, `Contrast2012`, `Highlights2012`, `Shadows2012`,
  `Whites2012`, `Blacks2012`, `Vibrance`, `Saturation`, `Texture`, `Clarity2012`,
  `Dehaze`, `Sharpness` and the sharpening and noise reduction detail sliders,
  `ToneCurvePV2012`,
  crop)
- `RetouchOp` = `MosaicOp { shapes: Shape[], blockSizeRel }`,
  `Shape = Rect | Polygon` in normalized image coordinates (0..1)
- `PhotoVersion { id, kind: 'develop' | 'retouch', ops }`
- `ExportPreset { id, name, folderTemplate, fileNameTemplate, ifExists, format, quality,
  colorSpace, resize, outputSharpening, metadata, stripGps, version, sendTo }`;
  `folderTemplate` is relative to `AppSettings.exportRoot` (or absolute) and expands
  `{variables}` from `@ee/metadata`, plus `{preset}`.
- `Destination` = `FolderDestination | FtpDestination | SftpDestination`,
  with `remotePathTemplate`
- `ExportJob { id, photoIds, presetId, send[], state, photos[] }` (per-photo progress)
- `JobEvent` stream (ingest progress, upload progress, errors)
- IPC: one typed map `IpcApi` of `channel -> (args) => Promise<result>` plus
  typed event channels. Preload exposes it as `window.ee`.
- `exportPresets:list/save/remove`, `export:start/cancel/list`, `export:render` and
  `export:rendererReady`; progress arrives as `export.progress` / `export.state`
  job events. `export:render` sends the RGBA render over IPC (full-resolution only
  for `resize: none`: about 180 MB for a 45 MP Z9 frame). That is fine for the PoC
  but a known cost to optimise later (e.g. MessagePort transfer or a shared temp file).

## Image ops (no sharp)

`sharp` (libvips) ships its own glib, which clashes with the glib/GTK that Electron
loads on Linux and segfaults the jobs process. App code therefore never imports it
(ESLint enforces this for `packages/*/src` and `crates/core/src`; tests may use it as
a devDependency). Image work goes through `@ee/core`, which is pure Rust (`zune-jpeg`,
`fast_image_resize`, `jpeg-encoder`): `decodeJpeg` (EXIF orientation applied),
`resizeRgba` (Lanczos3 on sRGB-encoded values, not gamma-correct, never upscales),
`encodeJpeg` (4:4:4 or 4:2:0, optional compact sRGB ICC, JFIF only otherwise) and
`makePreviews` (decode once, thumbnail and preview). Input is JPEG only; TIFF and PNG
are not decoded.

## Metadata conventions

- Raws: metadata in `<basename>.xmp` sidecar (Lightroom/Photo Mechanic
  compatible naming). JPEGs: embedded (IIM + XMP, kept in sync, UTF-8).
- Tag and colour class use Photo Mechanic's XMP namespace
  (`http://ns.camerabits.com/photomechanic/1.0/`, prefix `photomechanic`):
  `photomechanic:Tagged`, `photomechanic:ColorClass` and the combined
  `photomechanic:Prefs` string `tagged:colorClass:rating:frameNum`, with the
  rating/frame number preserved from an existing value. With label syncing on
  (the default) the class name is mirrored to `xmp:Label`; PM's defaults are
  Winner, Winner alt, Superior, Superior alt, Typical, Typical alt, Extras,
  Trash, and the table is overridable because PM lets users rename classes.
  Metadata lives in the sidecar (raws) or embedded XMP (JPEGs). Tag table:
  https://exiftool.org/TagNames/PhotoMechanic.html
- Develop settings: `crs:` namespace in the same sidecar.
- Retouch versions: namespace `ee:` (`http://ns.editing-experiment/1.0/`).
- PM metadata templates are `.XMP` files; code replacement files are
  tab-delimited text; variables use `{name}` syntax.

## Linear image format

`crates/core` decodes NEF via LibRaw to **demosaiced camera RGB**: linear, in
the camera's own primaries (`output_color = 0`), unity white balance
multipliers, no auto-brightening, black level subtracted, not clipped, alpha 1,
as RGBA half-float or float32, optionally downscaled to `maxEdge`.

White balance is a per-channel gain that is only correct in camera space, so it
must come before the camera → sRGB matrix. The header
(`LinearImageHeader` in `packages/contracts`) therefore carries what the
develop pipeline needs:

- `asShotMultipliers` (normalized g = 1),
- `cameraToSrgb`: 3x3 row-major, white-balanced linear camera RGB → linear
  sRGB/Rec.709 (LibRaw `rgb_cam`),
- `xyzToCamera`: 3x3 row-major, XYZ → camera RGB (LibRaw `cam_xyz`), used to
  convert temperature/tint ↔ multipliers like the DNG SDK,
- optional `asShotTemperature` / `asShotTint`.

Pipeline order: `camera RGB * multipliers → cameraToSrgb → develop ops → sRGB OETF`.

## Develop pipeline

One WebGL2 fragment shader (`packages/develop-gl`), per pixel, in this order (the
neighbourhood ops, see below, run in passes around it):

0. lens corrections, in the source fetch (see "Lens corrections: implementation"): the
   corrected-frame position the crop/straighten map produces is moved to where the lens
   recorded it, red and blue are fetched at their own (lateral CA) positions, and the
   vignetting gain multiplies the camera RGB;
1. white balance multipliers in camera space, with raw highlight clipping (channels are
   clamped to the lowest white point and blown pixels fade to neutral, so clipped
   areas go white, not pink), then `cameraToSrgb` to linear Rec.709;
2. Camera Calibration (`ShadowTint`, `RedHue/Saturation`, `GreenHue/Saturation`,
   `BlueHue/Saturation`) next to the camera matrix, as in Lightroom and RAWmakase:
   the measured primary matrices preserve neutrals, so greys stay grey;
3. exposure, then tone (highlights/shadows, contrast, whites/blacks) in linear light,
   applied as a luminance gain so hue is kept;
4. highlight shoulder per channel (values above ~0.9 roll off and reach 1.0 at 2.0
   scene-linear, so nothing hard clips);
5. sRGB encode (OETF);
6. parametric tone curve (`ParametricShadows/Darks/Lights/Highlights` and the three
   splits), then the point curve (master, then R/G/B), both folded into one encoded
   1D LUT. Lightroom puts the parametric curve between the basic tone stage and the
   point curve, and the point curve wins where they overlap;
7. vibrance / saturation, then the Color Mixer (HSL bands with smooth, overlapping
   hue weights; neutrals are gated out) and Color Grading (Shadows/Midtones/
   Highlights/Global hue, saturation and luminance, shaped by Blending and Balance;
   a legacy `SplitToning*` record renders as Blending 100), all in encoded space so
   the controls stay perceptual; Defringe (chroma reduction in the purple and green Oklab
   hue windows) follows the Color Grading;
8. post-crop vignette, relative to the crop's output rectangle rather than the
   uncropped source, then deterministic grain. Grain is seeded per photo and sampled
   in full-resolution source pixels with the preview/export scale, so a preview and
   the export get the same pattern with matching statistics.

The colour and effects maths lives in `packages/develop-gl/src/color/*.ts`
(`mixer`, `grading`, `calibration`, `parametric`, `effects`) with its GLSL mirror
in `src/glsl/color.ts`; `glsl.ts` has one clearly marked insertion point for
calibration and one for the per-pixel colour/effects stage. Calibration,
vignette and grain formulas are ported from RAWmakase (MIT); the mixer and
grading use smooth analytic weights rather than RAWmakase's measured binary
tables, so they approximate Camera Raw rather than matching it byte for byte.
`renderCpu` takes the same per-pixel positions and grain seed, which the browser
parity tests hold to the shader.

The sRGB encode comes before the curve because the curve is display-referred.
Absent `Temperature`/`Tint` mean as shot. If `Temperature` or `Tint` is set it
overrides `WhiteBalance: 'As Shot'`, so to return to as shot clear both (the preset
helper `applyPreset` does this for "As Shot" presets). A CPU reference of the same
maths (`renderCpu`) lives next to the shaders; a browser test checks that the two agree.
Export renders the same pipeline offscreen directly at the preset's output size
(full resolution only for `resize: none`), in tiles when the image or the output
exceeds GPU limits. All tunable constants are in `src/tuning.ts`.

### Neighbourhood ops

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
- **Raw defaults.** Lightroom starts a raw with Sharpness 40 / Radius 1.0 / Detail 25 /
  Masking 0 and Color Noise Reduction 25 / 50 / 50, and a Nikon NEF's own `crd:` block
  (camera-raw-defaults) replaces them with the camera's values (`readRawDefaults` in
  `@ee/metadata`, served by `develop:getDefaults`, never for JPEG/TIFF). They are not
  edits: the store keeps them in `editDefaults`, the sliders show `withDefaults(params,
  defaults)` and every render (canvas, edited previews, export) uses it, but a sidecar
  write holds only what the user set. An explicit `0` is off (so it is written), and
  putting a slider back on its default removes the key. The other `crd:` values (tone,
  saturation of the picture control) are not applied yet.
- **No `EXT_color_buffer_float`.** Every Chromium WebGL2 has it, but without it the
  renderer reports `supportsNeighbourhood: false`, leaves the neighbourhood settings out,
  renders the rest and calls `onNeighbourhoodUnavailable` once (the app shows one toast).
  Exports do not lose them: `renderWithFallback` (`develop-render.ts`) renders those
  settings with `renderCpu`, the same maths, up to `CPU_FALLBACK_MAX_PIXELS` (16 MP,
  about 100 bytes per pixel of float planes), and beyond that fails with a message
  saying which settings need GPU float support.

## Lens corrections: research and decision

Question: where do distortion, lateral CA and vignetting data for Nikon Z lenses come from, with
GPL-3.0-compatible licensing and the best result?

- **RAWmakase** (MIT) reads the correction the camera stores in every Nikon Z NEF and applies
  it by default, and treats the Lensfun database as an optional download that is never applied
  unasked. Its docs (`docs/lens-corrections.md`) compare the Nikon records with Adobe's own
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
- **Decision.** Two sources share one radial model, evaluated in the shader:
  1. *Built-in* (Nikon NEF) is the automatic choice. It needs no database, it is exact for the
     shot, and it follows the camera's Required/Optional flag (Required is on without the user
     asking; Optional waits for *Enable Profile Corrections*).
  2. *Lensfun* is the profile for everything else and the manual override in the profile select.
     A pruned copy (Nikon Z mount with every maker, and Nikon's own F-mount lenses; 0.3 MB, 74 kB
     gzipped) is vendored as `packages/develop-gl/data/lensfun.json` with the licence text and
     regenerated with `pnpm update-lensfun`. Only the *model maths* is ported (written from the
     documented formulas; no Lensfun code and no library). It is shipped as separate data under its
     own licence, not linked or merged into GPL code; the README attributes it.
  Adobe `.lcp` profiles are not read. `crs:LensProfileName` / `LensProfileFilename` are parsed
  and preserved but never applied or written for our own choice (our choice is `ee:LensProfile`),
  so Lightroom does not try to find an Adobe profile of a Lensfun name.

### Lens corrections: implementation

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

### Histogram, clipping and one-click tools

The histogram at the top of Develop is measured from the frame just drawn into the canvas:
`readHistogram` blits the drawing buffer into a small RGBA8 target (`blitFramebuffer`, long
edge 256) and reads that back, so it never re-renders the pipeline. Because it measures the
canvas, it is the lens-corrected, fully developed output (RGB and Rec. 709 luminance); the
same luminance bins are drawn faintly behind the Tone Curve editor. The renderer throttles the
readback to 5 Hz; it is skipped in crop mode, where the canvas has the crop-view overlays,
and on software rasterisers (SwiftShader/llvmpipe), where the readback blocks the frame. The
screenshot tour sets `EE_SCREENSHOTS=1` so it is still captured there.
The clipping overlay (`J`, or the corner triangles) is a view-only shader stage after the
colour and effects: red for clipped highlights, blue for crushed shadows. `renderToRGBA`
never enables it, so exports cannot contain it. Before/after (`Y`, or `\` as an optional
physical-key alias) draws `beforeParams` — the committed crop only — on the left via
`renderSplit`; it never writes parameters. The white balance picker (`W`) averages a small
patch of the unity-white-balance camera RGB and converts the neutralising gains with the
DNG-SDK temperature code, then writes Temperature/Tint through the normal parameter path.
Auto tone and Auto WB are ported from RAWmakase (MIT): gray-world in camera space with
clipping/noise rejection for white balance, and its linear fits to Lightroom Auto for the
six tone sliders plus Vibrance/Saturation. Auto tone measures a 1024 px render of the photo
with its tone, curves, presence, detail and effects removed.

Keyboard shortcuts match `event.key` letters and digits, not US key positions. Symbol keys
have letter/F-key primaries (`Y` before/after, `F1` or Ctrl/Cmd+`/` for shortcuts), and
AltGr is treated as character input so Swedish `@`, `$`, `{`… and dead keys never fire a
command.

## Crop mode

Crop mode works like Lightroom Classic's Crop Overlay. The crop frame is always an
axis-aligned rectangle on screen and the *image* turns underneath it; straightening
rotates the photo, not the frame. The stored crop (`EditParams.crop`, `crs:Crop*`) is
unchanged: the rotated rectangle in source space, whose output is the leveled frame.

- **Geometry** (`packages/develop-gl/src/crop.ts`, pure, unit tested): "view
  coordinates" are screen coordinates in source-pixel units with the frame centre at
  a `pivot` (`cropImageToView` / `cropViewToImage`). Helpers: `panCrop` (pan clamp),
  `rotateCrop` + `shrinkCropToImage` ("constrain to image": the frame shrinks about its
  centre, and grows back through a remembered `desired` size), `resizeCropFromHandle`
  (opposite side anchored, aspect lock, symmetric for Alt), `drawCrop` (the frame
  tool), `rotateCropInView` (keeps the pivot in step), `pointerAngleDelta`, `quantizeAngle` (0.1°, 1° with Shift) and
  `straightenAngleFromLine`.
- **GPU**: `renderer.renderView(params, view)` draws the whole image through the same
  shader and crop mapping as the normal view, only with a different transform (the
  existing output-scale and pivot uniforms, no CPU resampling): empty canvas outside
  the image, a dimmed area outside the frame. So the pixels inside the frame are the
  committed crop's, which is also what the export renders.
- **Store** (`CropSession` in `renderer/store.ts`): gestures (`beginCropGesture`,
  `updateCropGesture`, `endCropGesture`) work from a snapshot taken on pointer down, so
  Shift/Alt can change mid-drag. Panning and rotating keep the `pivot` (the frame does
  not move); resizing and drawing move it (the image does not move).
- **Pointer zones** (`renderer/crop-view.ts`, `hitTestFrame`): corners and edges
  resize; inside the frame pans the image; anywhere outside rotates about the frame
  centre (curved arrow cursor), following the pointer's angle, all the way to ±45°:
  constrain-to-image shrinks the frame instead of refusing. The stored corners are
  opposite corners of the *rotated* rectangle, so a wide frame tilted far one way
  stores them inverted (`bottom < top`); the angle disambiguates, so corner order is
  not a validity test (`isUsableCrop`: finite and distinct corners). Preset
  imports from other tools still require `right > left`.
- **Tools**: plain dragging outside the frame *rotates*, as in Lightroom. Drawing a new
  frame is the separate crop frame tool (toolbar "Frame" or `R`): it draws one frame
  (respecting the aspect lock) and hands back to the normal tool. The straighten tool
  (toolbar or `A`) takes a line drawn along the horizon on the displayed image.
- **Gestures** end on pointer up and are abandoned on pointer cancel or lost capture
  (the pre-gesture crop is restored). A double-click only commits when neither click
  was a drag. Mosaic shapes are not drawn while cropping (the live mosaic preview is
  cleared in crop mode); they show again after Apply.
- **Modifiers**: Shift toggles the aspect lock for the drag (a Free crop locks to its own
  ratio) and snaps a rotation to 1°; Alt/Option resizes or draws about the centre.
- **Overlays**: rule of thirds while interacting or hovering, a finer grid while
  rotating, `O` cycles thirds, grid, golden ratio, none.
- **Keys**: `C` enters (and applies), `Enter` or a double-click inside the frame
  applies, `Esc` cancels, `X` swaps orientation, `Ctrl/Cmd+Alt+R` resets, double-click on
  the angle slider resets the angle.
## Copy, paste and sync develop settings

Lightroom-style settings transfer. The groups are defined once in
`packages/contracts` (`DEVELOP_SETTING_GROUPS`, one entry per `EditParams` field;
a contract test fails when a new field is not assigned). Crop is in the list but
off by default. Retouch is not a develop setting, so it is never copied; mosaics
stay with each photo.

- **Copy settings** (`Shift+Ctrl/Cmd+C`) opens the group dialog for the active photo and
  remembers its settings (as shown, including raw defaults) with the chosen groups.
- **Paste settings** (`Shift+Ctrl/Cmd+V`) applies that snapshot to the selection in the
  Library or Develop. **Sync…** in the Library bottom bar opens the same dialog with
  the active photo as the source and applies it to the whole selection.
- **Previous** (`Ctrl/Cmd+Alt+V`) applies the settings of the last photo edited before
  the current one, with the default groups (everything except Crop). `event.code` is
  used for the V key because Option+V types another character on macOS, and AltGr
  (Ctrl+Alt on Windows/Linux) is ignored via `getModifierState('AltGraph')`.
- A paste is one `develop:applySettings` call carrying the source params and the group
  ids. The backend reads each photo's current settings, replaces only the selected
  groups (a field the source leaves neutral is removed), writes the sidecar and
  publishes the photo. Pending slider writes are flushed first, so unselected groups
  keep what the user sees.
- Thumbnails are redrawn through the existing `EditedPreviewScheduler`
  (`scheduleNow`, ahead of the debounce).
- There is no general undo stack in the app, so a batch paste is one write but not an
  undoable step yet.

## Export model

Three actions share one model: Export… (preset into a local folder), Export & send
(the same, then upload the exported files) and Next & send (one photo with the active
preset, then advance). A batch runs in the jobs process; the renderer stays usable.
`ifExists` picks suffix/overwrite/skip. Metadata modes write IPTC/XMP, optionally
copy camera EXIF and GPS from the original, or only copyright; `stripGps` drops the
location tags. Output sharpening is a simple luminance unsharp mask applied after
the resize (normally a no-op), in the jobs process, before encoding.

The renderer draws at the final output size so a 1600 px export never renders a
45 MP raw. `outputSizeForResize` is the one definition of that size: the renderer
uses it on the crop's pixel size and the encoder uses it to decide whether its own
resize is needed. Neighbourhood radii are in full-resolution source pixels and
`blockSizeRel` is relative to the image edge, so the smaller render has the same
look; a browser test compares a 2048 px direct render with a full-resolution
render downscaled to 2048 px.

## Renderer shell

`App.tsx` renders the top bar and one module view (`AppState.module`: `ingest`, `library`,
`develop`; Retouch is the Develop view with `AppState.retouch` set). `D`, `G` and `E` switch
modules (`keyboard.ts`); leaving Develop applies an open crop and saves a retouch session first.
Design tokens and component rules are in `docs/DESIGN.md`.

- **Library state** (`AppState.library`, `renderer/library.ts`): folder or collection, quick and
  colour-class filters, thumbnail size. The multi-selection is the shared `AppState.selection`
  (also used by the film strip and the export actions); a grid click is `select(id, mode)` with
  `replace`, `toggle` (Ctrl/Cmd) or `range` (Shift), where a range follows the grid's order in the
  Library and the film strip's elsewhere. The last clicked photo is `selectedId`, the one the
  inspector and Develop show. Tag (`T`) and class (`0`-`8`) act on the selection in the Library
  and on the open photo elsewhere, in one `photos:setLabels` call. Export… and Export & send
  use `openExportDialog` and `exportSelected(true)`.
- **Folders** come from `libraryFolders(photos)`: the directory of each photo's `path`, which is
  always the ingest copy. Sources are not consulted.
- **Batch caption** (`applyFieldEdits`) reads each photo's fields (`metadata:read`), merges the
  edits (replace, or append: text after a space, keywords as a union; `mergeFieldEdits`) and
  writes with `metadata:write`. Caption codes and `{variables}` are expanded per photo.
- The grid virtualises by rows from the scroll offset and reports its visible photos to the
  edited-preview scheduler like the film strip does.

## Screenshots

`pnpm screenshot [--out <dir>]` launches the built Electron app via Playwright
with mock data (`EE_MOCK=1`) and writes PNGs of the main views (Develop, crop, retouch, Library grid with
a multi-selection, loupe, Ingest, settings), then a real-mode run over the fixtures. Agents attach
them to PRs (see `AGENTS.md`).
