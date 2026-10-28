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
5. **Finish & next** renders a full-resolution JPEG with metadata and no
   leaked original thumbnail, uploads it to a target FTP/SFTP server, and
   advances to the next photo.

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
  (see "Linear image format").
- SQLite (built-in `node:sqlite`, `DatabaseSync`; no native module to rebuild per
  Electron ABI) in the utility process: photo index, source state
  (seen remote files), upload queue. It is a cache: XMP sidecars are the
  source of truth for metadata and edits.

## Backend (jobs process)

`apps/desktop/src/jobs/backend` implements every `IpcApi` channel outside mock mode. It has no
Electron dependency (`createBackend({ userDataDir, emit, getSecret })`), so integration tests run it
in plain Node. Files under Electron's `userData`:

```
settings.json        sources, destinations, ingest options, finish action
index.sqlite         photo index (cache; sidecars are the source of truth)
seen.sqlite          files already ingested per source
uploads.sqlite       upload queue
presets/*.json       imported develop presets
credentials.json     written by main only: ciphertext from safeStorage
cache/{thumb,preview,linear}   disposable
exports/<photoId>/   exported JPEGs
```

- Ingest: `@ee/ingest` with the `{variable}` expander from `@ee/metadata` and a per-file hook that reads
  camera data, caches a 2560px preview and a 320px thumbnail, applies the PM template, indexes the
  photo and emits `photos:added`. Ingest awaits the hook per source, so photos appear in copy order.
- `app://thumb|preview` are cached JPEGs. `app://linear/<id>?maxEdge=N` is decoded in the jobs process
  (f16), written to `cache/linear` (small LRU) and streamed from there by main, with the
  `LinearImageHeader` in `x-ee-linear-image`. Main only streams files below `cache/`.
- Secrets: `credentials:set/remove` run in main (`safeStorage`, no plaintext fallback). The jobs process asks
  for a secret by `credentialRef` over a private `MessagePort` (`shared/secret-port.ts`) when it connects;
  there is no channel that returns a secret to the renderer.
- Edits: develop params are the `crs:` block of the sidecar (one develop version per photo), retouch
  versions are `ee:RetouchVersions`. Writes to one photo's sidecar are serialised.
- On quit, main asks the jobs process to shut down (stop ingest, close the upload queue, ExifTool and
  the databases) and kills it only after a timeout.

## Contracts (`packages/contracts`)

Key types (names are binding, fields can grow):

- `PhotoId` (string, stable per file), `Photo { id, path, sidecarPath,
  fileName, captureTime?, camera?, sourceId, status, versions }`
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
  `Whites2012`, `Blacks2012`, `Vibrance`, `Saturation`, `ToneCurvePV2012`,
  crop)
- `RetouchOp` = `MosaicOp { shapes: Shape[], blockSizeRel }`,
  `Shape = Rect | Polygon` in normalized image coordinates (0..1)
- `PhotoVersion { id, kind: 'develop' | 'retouch', ops }`
- `ExportPreset { maxEdge?, quality, metadata: 'all' | 'iptc' | 'none' }`
- `Destination` = `FolderDestination | FtpDestination | SftpDestination`,
  with `remotePathTemplate`
- `FinishAction { exportPreset, destinations[] }` (configurable "Finish & next")
- `JobEvent` stream (ingest progress, upload progress, errors)
- IPC: one typed map `IpcApi` of `channel -> (args) => Promise<result>` plus
  typed event channels. Preload exposes it as `window.ee`.
- `export:photo` sends the full-resolution RGBA render over IPC. That is fine for
  the PoC (about 180 MB for a 45 MP Z9 frame) but a known cost to optimise later
  (e.g. MessagePort transfer or a shared temp file).

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
2. exposure, then tone (highlights/shadows, contrast, whites/blacks) in linear light,
   applied as a luminance gain so hue is kept;
3. highlight shoulder per channel (values above ~0.9 roll off and reach 1.0 at 2.0
   scene-linear, so nothing hard clips);
4. sRGB encode (OETF);
5. tone curve (master, then R/G/B), defined on the encoded 0..255 axis, as a 1D LUT;
6. vibrance / saturation, in encoded space.

The sRGB encode comes before the curve because the curve is display-referred.
Absent `Temperature`/`Tint` mean as shot. If `Temperature` or `Tint` is set it
overrides `WhiteBalance: 'As Shot'`, so to return to as shot clear both (the preset
helper `applyPreset` does this for "As Shot" presets). A CPU reference of the same
maths (`renderCpu`) lives next to the shaders; a browser test checks that the two agree.
Export renders the same pipeline offscreen at full resolution, in tiles when the image
or the output exceeds GPU limits. All tunable constants are in `src/tuning.ts`.

## Screenshots

`pnpm screenshot [--out <dir>]` launches the built Electron app via Playwright
with mock data (`EE_MOCK=1`) and writes PNGs of the main views. Agents attach
them to PRs (see `AGENTS.md`).
