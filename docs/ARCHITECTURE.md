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
crates/core           Rust napi-rs addon: vendored LibRaw, previews, raw decode
packages/contracts    Shared TS types + IPC channel definitions (no runtime deps)
packages/metadata     ExifTool service, PM templates, code replacements, variables, sidecars
packages/ingest       Sources (folder/card, FTP/SFTP poller), copy workers, rename, verify
packages/export       JPEG encode (sharp), thumbnail stripping, upload queue (FTP/FTPS/SFTP)
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
- SQLite (better-sqlite3) in the utility process: photo index, source state
  (seen remote files), upload queue. It is a cache: XMP sidecars are the
  source of truth for metadata and edits.

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

## Metadata conventions

- Raws: metadata in `<basename>.xmp` sidecar (Lightroom/Photo Mechanic
  compatible naming). JPEGs: embedded (IIM + XMP, kept in sync, UTF-8).
- Develop settings: `crs:` namespace in the same sidecar.
- Retouch versions: namespace `ee:` (`http://ns.editing-experiment/1.0/`).
- PM metadata templates are `.XMP` files; code replacement files are
  tab-delimited text; variables use `{name}` syntax.

## Linear image format

`crates/core` decodes NEF via LibRaw to camera-space → linear Rec.709/sRGB
primaries (LibRaw camera matrix), white balance **not** baked in (as-shot WB
multipliers returned alongside), as RGBA half-float or float32, optionally
downscaled to `maxEdge`. The develop pipeline applies WB and everything else.

## Develop pipeline

WebGL2 fragment-shader passes over the linear texture: WB → exposure →
tone (contrast/highlights/shadows/whites/blacks) → tone curve → vibrance /
saturation → output transform (sRGB). A CPU reference implementation of the
same maths lives next to the shaders and is used in tests. Export renders the
same pipeline offscreen at full resolution.

## Screenshots

`pnpm screenshot [--out <dir>]` launches the built Electron app via Playwright
with mock data (`EE_MOCK=1`) and writes PNGs of the main views. Agents attach
them to PRs (see `AGENTS.md`).
