# Architecture

## Proof of concept: scope and demo

This is an AI-developed proof of concept: AI coding agents wrote the code, an AI
orchestrator directed and reviewed it, and the repository owner set the direction and
decisions. It is not production software.

The proof of concept covers one end-to-end workflow:

1. **Ingest.** Local folders, cards and polled FTP/FTPS/SFTP sources are ingested in
   parallel, each in filename order, with rename and subfolder templates, SHA-256
   verification, an optional backup destination, a Photo Mechanic metadata template
   (Replace by default, or Fill empty) and an optional develop preset. Local sources
   filter by file type (RAW / JPEG / Both), lock state (Locked / Unlocked / All) and
   incremental ingest (on by default). XMP sidecars are written and thumbnails appear
   live in the film strip.
2. **Library.** A virtualised grid and loupe, multi-selection, quick and colour-class
   filters, ratings, colour classes, tagging and batch captioning.
3. **Develop.** A Lightroom-compatible `crs:` parameter set, imported `.xmp` presets,
   camera profiles, lens corrections, crop/straighten, copy/paste/sync of settings and a
   live WebGL2 preview.
4. **Retouch.** Rectangle, lasso and magic-wand selections, YuNet face detection inside
   a region, and mosaic/pixelate of the selected faces.
5. **Export / Export & send.** Render a JPEG at the active export preset's output size
   with metadata and no leaked original thumbnail into the preset's local folder, then
   upload the exported file to a target FTP/FTPS/SFTP server. Next & send advances to the
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

## Decision records

- [0001 Camera profiles](decisions/0001-camera-profiles.md)
- [0002 Lens corrections](decisions/0002-lens-corrections.md)
- [0003 Neighbourhood operations](decisions/0003-neighbourhood-ops.md)

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

## Dependency declarations

`apps/desktop` declares `basic-ftp`, `exiftool-vendored`, `fast-xml-parser`,
`onnxruntime-node` and `ssh2-sftp-client` directly even though the workspace packages
that import them also depend on them. electron-vite externalises the app's
`dependencies`, so declaring them keeps them out of the main/jobs bundle and resolves
them at runtime; the native packages (`exiftool-vendored`, `onnxruntime-node`) must not
be bundled. Keep these declarations. The `@fontsource-variable/*` packages are imported
from `renderer/fonts.css` and are bundler inputs, not runtime externals.

## Backend (jobs process)

`apps/desktop/src/jobs/backend` implements every `IpcApi` channel outside mock mode. It has no
Electron dependency (`createBackend({ userDataDir, emit, getSecret })`), so integration tests run it
in plain Node. Files under Electron's `userData`:

```
settings.json        sources, destinations, ingest options, export presets, active preset, profile folders
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
  camera data, caches a 2560px preview and a 320px thumbnail, applies the PM template (replace
  existing values by default, or fill empty fields) and the configured develop preset, indexes the
  photo and emits `photos:added`. Ingest awaits the hook per source, so photos appear in copy order.
  A preset is merged over the file's current `crs:` settings, so a photo that arrived with its own
  develop settings (e.g. an existing Lightroom sidecar) keeps them; a missing preset is skipped with
  one warning per job. Applying a preset marks the photo edited and `previewStale`, so the
  edited-preview scheduler draws it.
- Local source filters (`FolderSource`/`CardSource`): `fileTypes` is `raw` (supported raw formats and
  their XMP sidecars), `jpeg` (`.jpg`/`.jpeg`) or `both` (the default, every supported image,
  including HEIF/TIFF/PNG/WebP/AVIF); `lockFilter` is `locked`, `unlocked` or `all` (default);
  `incremental` (default on) skips files the seen-store already has. A RAW+JPEG pair with the same
  base name in one folder is locked when either file is locked, and that is decided before the type
  filter, so `raw` copies a RAW whose JPEG alone was locked. Locked means the camera's protect
  attribute, read from `fs.stat().mode` as `(mode & 0o222) === 0` on Linux vfat/exfat, macOS
  msdos/exfat and Windows (`FILE_ATTRIBUTE_READONLY`). A read-only volume makes every file look
  locked, so `@ee/ingest` probes the source directory with `fs.access(dir, W_OK)` (never a write); if
  that fails (`EROFS`, or a directory that is not writable) the lock run stops with the warning
  "Card is mounted read-only; can't tell locked photos apart" instead of copying everything or
  nothing. Progress reports `filesScanned` (before filters), `filesTotal` (new files to copy) and
  `filesSkipped` (already ingested), so the UI can show "12 locked of 480" and
  "142 new · 338 already ingested". With incremental off the existing collision handling adds
  numeric suffixes; ingest never overwrites.
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
  `remotePath`, `deleteAfterDownload` default false, `credentialRef`).
  `FolderSource` and `CardSource` also have optional `fileTypes` (`both` default),
  `lockFilter` (`all` default) and `incremental` (`true` default); remote sources
  have none of them.
- `IngestConfig { sources, destination, backupDestination?, renameTemplate,
  metadataTemplatePath?, metadataTemplateMode?, developPresetId?, codeReplacementPaths[] }`;
  the template mode is `replace` (default) or `fillEmpty`.
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

## Image operations (no sharp)

`sharp` (libvips) ships its own glib, which clashes with the glib/GTK that Electron
loads on Linux and segfaults the jobs process. App code therefore never imports it
(ESLint enforces this for `packages/*/src`, `crates/core/src` and `apps/*/src`; tests
may use it as a devDependency). Image work goes through `@ee/core`, which is pure Rust (`zune-jpeg`,
`fast_image_resize`, `jpeg-encoder`): `decodeJpeg` (EXIF orientation applied),
`resizeRgba` (Lanczos3 on sRGB-encoded values, not gamma-correct, never upscales),
`encodeJpeg` (4:4:4 or 4:2:0, optional compact sRGB ICC, JFIF only otherwise) and
`makePreviews` (decode once, thumbnail and preview). The core decodes JPEG (and raw via
LibRaw) only; TIFF, PNG, HEIF and WebP are ingested but have no decoded preview.

## Metadata conventions

- Raws: metadata in `<basename>.xmp` sidecar (Lightroom/Photo Mechanic
  compatible naming). JPEGs: embedded (IIM + XMP, kept in sync, UTF-8).
- Tag and colour class use Photo Mechanic's XMP namespace
  (`http://ns.camerabits.com/photomechanic/1.0/`, prefix `photomechanic`):
  `photomechanic:Tagged`, `photomechanic:ColorClass` and the combined
  `photomechanic:Prefs` string `tagged:colorClass:rating:frameNum`, with the
  frame number preserved from an existing value and the rating mirrored to
  `xmp:Rating` (0 removes it). Reading takes Prefs first, then `xmp:Rating`.
  With label syncing on
  (the default) the class name is mirrored to `xmp:Label`; PM's defaults are
  Winner, Winner alt, Superior, Superior alt, Typical, Typical alt, Extras,
  Trash, and the table is overridable because PM lets users rename classes.
  Metadata lives in the sidecar (raws) or embedded XMP (JPEGs). Tag table:
  https://exiftool.org/TagNames/PhotoMechanic.html
- Develop settings: `crs:` namespace in the same sidecar.
- Retouch versions: namespace `ee:` (`http://ns.editing-experiment/1.0/`).
- PM metadata templates are `.XMP` files; code replacement files are
  tab-delimited text; variables use `{name}` syntax. Ingest replaces existing
  values by default (cameras write their own copyright/artist); "fill empty"
  is the opt-in alternative. For embedded JPEG/TIFF metadata the template's
  `copyright`/`byline` are also written to EXIF `Copyright`/`Artist`, as MWG
  requires them to agree with XMP/IPTC. Raws are never written: their EXIF is
  left alone and the template goes to the sidecar.

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

Pipeline order: `camera RGB * multipliers → cameraToSrgb → develop ops → sRGB OETF`. With a camera
profile the matrix and the highlight shoulder are replaced, see [ADR 0001](decisions/0001-camera-profiles.md).

## Develop pipeline

One WebGL2 fragment shader (`packages/develop-gl`), per pixel, in this order (the
neighbourhood ops run in passes around it; see [ADR 0003](decisions/0003-neighbourhood-ops.md)):

0. lens corrections, in the source fetch (see [ADR 0002](decisions/0002-lens-corrections.md)): the
   corrected-frame position the crop/straighten map produces is moved to where the lens
   recorded it, red and blue are fetched at their own (lateral CA) positions, and the
   vignetting gain multiplies the camera RGB;
1. white balance multipliers in camera space, with raw highlight clipping (channels are
   clamped to the lowest white point and blown pixels fade to neutral, so clipped
   areas go white, not pink), then `cameraToSrgb` to linear Rec.709 (with a camera profile:
   its forward matrix to ProPhoto, the HueSatMap and the baseline offset, then to Rec.709, see
   [ADR 0001](decisions/0001-camera-profiles.md));
2. Camera Calibration (`ShadowTint`, `RedHue/Saturation`, `GreenHue/Saturation`,
   `BlueHue/Saturation`) next to the camera matrix, as in Lightroom and RAWmakase:
   the measured primary matrices preserve neutrals, so greys stay grey;
3. exposure, then tone (highlights/shadows, contrast, whites/blacks) in linear light,
   applied as a luminance gain so hue is kept;
4. highlight shoulder per channel (values above ~0.9 roll off and reach 1.0 at 2.0
   scene-linear, so nothing hard clips); with a camera profile the profile's LookTable, XMP
   look table and tone curve take its place;
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

Texture, Clarity, Dehaze, sharpening and noise reduction run as separate passes around
the per-pixel chain. Their order, pyramid, tiling, caching and CPU parity are in
[ADR 0003](decisions/0003-neighbourhood-ops.md).

### Raw defaults and GPU fallback

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

## Camera profiles

A raw is rendered through a camera profile when one is available: DNG `.dcp` files and
Adobe XMP looks provide the camera matrices, hue/saturation tables, look table and tone
curve. The formats, parsers, matching, pipeline order, white balance, current limitations
and tests are in [ADR 0001](decisions/0001-camera-profiles.md).

## Lens corrections

Distortion, lateral CA and vignetting come from the camera's own records in Nikon Z NEFs,
with Lensfun as the fallback and manual override. They are applied in the source fetch,
before everything else, in the corrected frame. The research, decision, radial model,
profile choice, tiling, retouch mapping and verification steps are in
[ADR 0002](decisions/0002-lens-corrections.md).

## Histogram, clipping and one-click tools

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
command. Ratings are plain `1`-`5` (0 clears); colour classes are the platform's primary
modifier plus `1`-`8` (0 clears), falling back to `event.code` when a layout changes the
digit under the modifier.

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
  inspector and Develop show. Tag (`T`), rating (`1`-`5`, `0` clears) and class
  (Ctrl/Cmd+`1`-`8`, `0` clears) act on the selection in the Library and on the open photo
  elsewhere, in one `photos:setLabels` call. Export… and Export & send
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
