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
5. **Next & send** renders a full-resolution JPEG with metadata and no
   leaked original thumbnail into the active export preset's local folder,
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
   │  WebGL2 develop preview + full-res export render       │
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
  camera matrix so develop preview and full-resolution export work for them too.
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
  each full-resolution render over `jobs:event` (`export.render`); the renderer replies with
  `export:render` (RGBA over IPC, the same PoC cost as the old finish action). The jobs process then
  resizes, applies output sharpening (a luminance unsharp mask in `packages/export`), encodes,
  writes metadata, runs `assertNoEmbeddedPreviews`, publishes atomically and only then enqueues the
  exported file for upload. Jobs are persisted in `export-jobs.json`; after a restart the current
  photo is queued again once the renderer calls `export:rendererReady`.
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
  job events. `export:render` sends the full-resolution RGBA render over IPC. That is
  fine for the PoC (about 180 MB for a 45 MP Z9 frame) but a known cost to optimise
  later (e.g. MessagePort transfer or a shared temp file).

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

One WebGL2 fragment shader (`packages/develop-gl`), per pixel, in this order:

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
   the controls stay perceptual;
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
Export renders the same pipeline offscreen at full resolution, in tiles when the image
or the output exceeds GPU limits. All tunable constants are in `src/tuning.ts`.

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
- **Crop mode** (`renderView`) draws the single develop pass, so Texture, Clarity,
  Dehaze, sharpening and noise reduction are not shown while the crop frame is being
  edited; they show again after Apply (the normal render and the export use the pipeline).
- Needs `EXT_color_buffer_float` (present in every Chromium WebGL2); without it the
  neighbourhood controls throw a `DevelopGlError` and the rest still renders.

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
## Export model

Three actions share one model: Export… (preset into a local folder), Export & send
(the same, then upload the exported files) and Next & send (one photo with the active
preset, then advance). A batch runs in the jobs process; the renderer stays usable.
`ifExists` picks suffix/overwrite/skip. Metadata modes write IPTC/XMP, optionally
copy camera EXIF and GPS from the original, or only copyright; `stripGps` drops the
location tags. Output sharpening is a simple luminance unsharp mask applied after
the resize, in the jobs process, before encoding.

## Screenshots

`pnpm screenshot [--out <dir>]` launches the built Electron app via Playwright
with mock data (`EE_MOCK=1`) and writes PNGs of the main views. Agents attach
them to PRs (see `AGENTS.md`).
