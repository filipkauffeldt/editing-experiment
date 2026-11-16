# Architecture

## Proof of concept: scope and demo

This is an AI-developed proof of concept: the code was written and reviewed by AI
agents, with direction and decisions from the repository owner. It is not production
software.

The proof of concept covers one end-to-end workflow:

1. **Ingest.** Local folders, cards and polled FTP/FTPS/SFTP sources are ingested in
   parallel, each in filename order, keeping the original names or renaming with a
   template (plus an optional subfolder template), SHA-256
   verification, an optional backup destination, a Photo Mechanic metadata template
   (Replace by default, or Fill empty) and an optional develop preset. Local sources
   filter by file type (RAW / JPEG / All), lock state (Locked / Unlocked / All) and
   skipping what was already ingested (on by default). A folder source can also keep
   watching for new files while its run goes. XMP sidecars are written and thumbnails appear
   live in the film strip.
2. **Library.** A virtualised grid and loupe, multi-selection, the shared filter bar,
   ratings, colour classes, tagging, batch captioning and a capture time shift.
3. **Develop.** A `crs:` parameter set that follows Lightroom's names, develop presets from Lightroom
   and Camera Raw's preset folders or imported,
   camera profiles, lens corrections, crop/straighten, copy/paste/sync of settings, per-photo undo
   and redo for the session, Reset all, and a live WebGL2 preview.
4. **Retouch.** Rectangle and lasso areas, YuNet face detection inside a rectangle or lasso, and
   mosaic/pixelate of the areas. Every area can be switched on and off, added or subtracted, and a
   saved retouch can be resumed and edited again.
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
scripts/              fetch-fixtures, screenshot helpers, packaging (package-app)
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
  camera matrix so the develop preview and export path is used for them too.
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
from `renderer/fonts.css` and react and react-dom are imported by the renderer only. They are
bundler inputs, not runtime externals, so they are dev dependencies and the packaged app does not
carry them.

## Backend (jobs process)

`apps/desktop/src/jobs/backend` implements every `IpcApi` channel outside mock mode. It has no
Electron dependency (`createBackend({ userDataDir, emit, getSecret })`), so integration tests run it
in plain Node. Settings live in two files. `settings.json` in the settings folder is shared between
computers; `machine.json` under Electron's `userData` holds the paths that belong to this computer.
The default settings folder is `userData`, so both files sit there until the user picks another.

```
machine.json         settings folder choice, ingest destination and backup folder, export root, folder and card sources, folder destinations, profile folders, preset folders, panel widths, and every metadata template or code replacement path outside the settings folder
window-state.json    size, position and maximised state of the main window (this machine only, so it is not in settings.json)
logs/                ee.log and ee.1.log … ee.4.log, see "Logging"
index.sqlite         photo index, the search text of each photo, the folders added to the Library in place and the paths removed from the Library (cache; sidecars are the source of truth); flat folder, label, status and camera columns answer the Library queries from indexes
seen.sqlite          files already ingested per source
uploads.sqlite       upload queue
export-jobs.json     resumable export batches (queued photos survive a restart)
exported-files.json  paths the app exported; the only targets `overwrite` may replace
credentials.json     written by main only: ciphertext from safeStorage
cache/{thumb,preview,full,linear}   disposable (see "Edited thumbnails and previews" and "Culling a burst")
exports/             default exportRoot (only a relative folder template uses it; the default template exports next to the photo)
```

The settings folder holds:

```
settings.json        FTP/SFTP sources and destinations (credentialRef only, never a secret), export presets and the active one, ingest naming and templates, template mode, develop preset, metadata template and code replacement references, copy/paste selections
presets/*.json       develop presets imported by hand (presets found in preset folders are not copied here)
settings.json.pre-settings-folder   the old one-file settings, kept after the first split
```

- Ingest: `@ee/ingest` with the `{variable}` expander from `@ee/metadata` and a per-file hook that reads
  camera data, caches a 2560px preview and a 320px thumbnail, applies the PM template (replace
  existing values by default, or fill empty fields) and the configured develop preset, indexes the
  photo and emits `photos:added`. Ingest awaits the hook per source, so photos appear in copy order.
  A raw that arrives with an XMP sidecar takes its capture time from the sidecar, so a time
  shifted before ingest survives.
  A preset is merged over the file's current `crs:` settings, so a photo that arrived with its own
  develop settings (e.g. an existing Lightroom sidecar) keeps them; a missing preset (see "Develop
  presets") is skipped with one warning per job, and never fails the copy. Applying a preset marks the photo edited and `previewStale`, so the
  edited-preview scheduler draws it.
- Modified times: every ingested copy (primary, backup and both sidecars) gets the source file's
  modified time, set on the verified temp file before it is placed, so the final name never shows
  another time and the source is only read. A remote entry with no time (a plain FTP `LIST` has none;
  SFTP and `MLSD` do) is left with the time of the copy. A failure to set it is a warning. A raw is
  never written to, so it keeps the time; a JPEG that takes the template or a preset is rewritten by
  ExifTool, so the pipeline puts its time back afterwards and gives the backup copy the same. A raw's
  sidecar is created or rewritten by those steps and legitimately gets the time of the write, and the
  backup sidecar mirrors it. Later edits (labels, captions, retouch) are ordinary writes and update
  the time of the file they write.
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
  numeric suffixes; ingest never overwrites. Keeping original names uses the source's own base
  name and the same suffix rule; the suffix is decided once per source and base, so a raw/JPEG
  pair and its XMP sidecar keep matching names while two sources race for the same shot.
- Watched folder sources: `FolderSource.watchForNewFiles` (default false) keeps a folder source's
  run going after the first pass. During the run the source rescans its folder (and subfolders when
  `recursive`) every second and copies files that appear through the same filters, rename, template,
  preset, verification and seen-store path as an ordinary pass. The row reports `watching` with the
  files copied so far, like a polled server, and its Stop ends the watch. Only a running ingest run
  watches: nothing resumes at launch and a card has no such option. A file is copied only after its
  size and modified time stayed the same for a three-second quiet period. A modified time already
  older than that counts as quiet time when its clock is usable, so files already in the folder are
  not held for the whole period. The period is three seconds because FAT and exFAT keep modified
  times in two-second steps. A file that changes is left for a later look and never fails the run.
  An empty file is not taken. One path with one size and modified time is copied at most once per
  run, also with incremental off. `filesSkipped` counts only files the seen store had before the
  run started,
  so a file this run copied is not reported as already ingested. A file that disappears between the
  look and the copy is skipped without failing the run. The scan is `readdir` and `stat` on an
  interval, not `fs.watch`, because recursive watching is not dependable across Linux, macOS,
  Windows and network drives. A source whose later scan fails (a network share that went away)
  keeps watching and reports the error once. When the folder returns, copying resumes and the run
  keeps its first error on the row, as every ingest run does.
- Added folders in place: **Add folder…** in the Library sidebar indexes every supported image
  below a folder, subfolders included, without copying, moving or renaming anything. Each file goes
  through the same per-file work as an ingest copy after the copy (`createOnFileIngested`: camera
  data, cached 2560 px preview and 320 px thumbnail, labels, existing `crs:` develop settings and
  `ee:` retouch versions, then the index and `photos:added`) with no metadata template and no
  develop preset, so existing metadata is read rather than replaced and a file that arrives with
  edits is marked edited and `previewStale`. The index row has `inPlace: true`, no `source_path`,
  and `sourceId` `in-place`. The run is in the jobs process and reports `library.progress` /
  `library.state`; the sidebar shows its count and a Stop button. Files are read, previewed and
  indexed four at a time; the index writes and `photos:added` stay in file-name order per folder.
  A second add or rescan of the same root is refused while one is running, with a message to stop
  it first. An unreadable file is counted as
  skipped and the rest go on. Folders the app exported into are skipped by the existing `.ee-export`
  marker, `export` name and `exported-files.json` rules, and a file whose path is already indexed is
  skipped, so adding a folder twice or adding a parent of an added folder is safe. Added roots live
  in the `added_folders` table of `index.sqlite` (created if missing, so an older index opens), not
  in `settings.json`. Every added root has a sidebar row even when all its photos are in subfolders,
  with its whole-tree count; adding never creates or rewrites a sidecar or any other file in it.
  Nothing rescans an added folder by itself, at startup or on a timer:
  **Rescan folder** in its right-click menu indexes what appeared since, and a folder that is not
  available is reported without changing anything. Photos in an added folder stay listed when its
  drive is disconnected; opening one fails with the existing preview error. The startup scan of the
  ingest destination skips added roots, so a folder added below the destination is only looked
  through when asked.
- Added-folder safety: a folder is refused when it is inside or contains a configured card or
  folder source, is on a memory card (`CardScanner`'s volume with a `DCIM` folder), or is the app's
  data or cache folder or contains it. Every comparison uses the written and the real path, so a
  symlink cannot lead into one, and is case-folded on macOS and Windows. The message says why and
  points to Ingest. Working in place writes only what an edit writes: raws never change and their
  metadata goes to the sibling XMP sidecar, JPEG metadata is embedded in the JPEG. Exports follow
  the preset, by default into an `export` folder next to the photo, which a later rescan skips.
  **Remove folder from Library…** on a sidebar folder removes its photos the
  `photos:removeFromLibrary` way (paths recorded in `removed_paths`, no disk access). The dialog
  has **Include subfolders**; an added root starts with it ticked and a folder that is not a root
  starts with it clear. With it the whole tree goes, the folder's added root is forgotten with any
  added root below it, and a root without subfolders still forgets itself. Without it only the
  exact folder's photos go and subfolders stay. The removal is one index transaction and one
  `photos:removedMany` event, so a 3,000 photo folder does not send 3,000 events. Delete of an
  in-place photo is the explicit trash action through `PhotoDeleter`, with every source and
  sidecar check unchanged.
- Card discovery: `CardScanner` (`@ee/ingest`, `cards.ts`) runs in the jobs process behind
  `sources:detectCards`. It imports no native module and runs no platform tool; the one thing Node
  cannot see, a Windows volume label, comes through the injected `readDriveInfo` option, which
  the jobs process fills from `@ee/core`. It scans `/media/<user>`,
  `/run/media/<user>` and `/media` on Linux, `/Volumes` on macOS (symlinks, i.e. the boot volume,
  are skipped) and the drives D: to Z: on Windows, and keeps volumes that have a `DCIM` folder.
  Nothing scans in the background: the renderer scans once when the Ingest view opens and when
  the user presses **Rescan cards** (`AppStore.refreshCards`; a click during a running scan gets
  one more scan after it). A scan lists the cards at once, without counts (`recount: true`); the
  images are then counted in the background and the numbers arrive on a second call
  (`waitForCounts: true`), so every rescan recounts and the list never waits for a count.
  Every filesystem call has a timeout and runs concurrently with the others; a call that timed
  out is not issued again while it is still pending, so a dead network drive holds one libuv
  thread (the jobs process runs with `UV_THREADPOOL_SIZE=16`). A timeout, a pending call or a
  failure is "unknown", not "gone": a card found before stays listed (with its last count) and
  keeps its tick until a definite answer (no `DCIM`, or a completed listing without it), and a
  volume never seen before needs a positive answer to appear. A listing that fails for a reason
  other than "not there" is not read as "no cards". On Windows each drive letter D: to Z:
  (never C:) is asked separately through `readDriveInfo(['E:\'])` under the same timeout and
  in-flight rule as every other probe, so a drive that stalls delays only itself. The native
  function (`crates/core/src/drives.rs`, hand-written kernel32 FFI, run on the libuv threadpool)
  returns `GetDriveTypeW` and, for removable and fixed drives only, the label from
  `GetVolumeInformationW` (`MAX_PATH + 1` UTF-16 units, so `Å`, `Ä`, `Ö` survive). It sets
  `SEM_FAILCRITICALERRORS` on its thread around the calls and restores it, so an empty reader slot
  fails instead of opening "There is no disk in the drive". Fixed drives count because many USB and
  CFexpress readers present a card as a fixed disk. Network, optical and unused letters are dropped
  before any `DCIM` probe, so they are never touched; so is a removable or fixed drive whose volume
  cannot be read because there is no medium (`ERROR_NOT_READY`, `ERROR_NO_MEDIA_IN_DRIVE`,
  `ERROR_UNRECOGNIZED_VOLUME`). A card without a label, a failed or timed out lookup and a missing
  native module all fall back to "Drive E" (or the label the card had when it was last found, if
  the lookup is unknown on a later scan) and the `DCIM` check decides as before. Off Windows the
  native function returns nothing and is not called. `EE_CARD_ROOTS` replaces the scanned folders
  (tests only).
  Ticking a card (`pickCard`) creates a `CardSource` with `discovered: true`, once per volume:
  the next time the volume appears it is matched to that source by mount path, else by volume
  label (a source whose mount path is not a mounted card now), so filters and incremental state
  survive re-insertion and two cards named `NIKON Z 6` keep separate sources (the second is
  named `NIKON Z 6 (2)`). A source saved on Windows as "Drive E" still matches the card in the same
  drive letter once the card shows its real label (the mount path comes first), keeps its id, tick
  and filters, and gets the new `volumeLabel` saved; its name stays "Drive E". If that card later
  turns up under another letter it no longer matches by label (the saved label is the generic
  one), so it gets a new source named after its label and the old one is left behind. There is no
  volume serial number or other identity beyond mount path and label. A discovered source is ingested only while it is ticked; ticks are not
  persisted and reset when a scan no longer finds the card, unless its run is still going.
  Hand-added card sources are ingested like folders, and a mounted card they already cover is
  not offered again. A card pulled out after the last scan and ticked still goes into the
  ingest: its own run fails with `Card "<name>" is not available at <mount>…`, shown on its
  row, and the other sources carry on. The seen-store remembers a card's files by path below the
  mount point, so a different drive letter or mount path does not make everything new again
  (older absolute entries still count).
- `app://thumb|preview` are cached JPEGs. `app://full/<id>` is the camera's full-size JPEG (see
  "Culling a burst"). `app://linear/<id>?maxEdge=N` is decoded in the jobs process
  (f16 for raws, f32 for JPEGs), written to `cache/linear` (an LRU of 6 files and 1.5 GiB) and streamed from
  there by main, with the `LinearImageHeader` in `x-ee-linear-image`. Main only streams
  files below `cache/`.
- Secrets: `credentials:set/remove` run in main (`safeStorage`, no plaintext fallback), and
  `credentials:present` answers which references have a secret on this computer without decrypting
  or returning one. The jobs process asks for a secret by `credentialRef` over a private `MessagePort`
  (`shared/secret-port.ts`) when it connects; there is no channel that returns a secret to the
  renderer. An absent/empty `credentialRef` on an FTP source or destination means anonymous FTP
  (user `anonymous`), so demos and tests need no keyring. A reference with no secret on this
  computer is not anonymous: the connection fails and the lists say "Password needed".
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
  `suffix`; `overwrite` only replaces a path recorded in `exported-files.json`. With
  `fileNaming: 'keep'` the same rule applies to the photo's base name, so repeat exports and a
  raw/JPEG pair sharing a base get `-1`, `-2`, … before the extension. The render request
  carries the ops key (`retouchOpsKey`) the jobs process expects; the renderer echoes the key of the
  ops it applied and the jobs process rejects a stale or mosaic-less render.
- Export folder: the default `folderTemplate` is `{photofolder}/export`, so a photo at
  `/Photos/20261104_GAIS-AIK/_DSC1234.NEF` exports to `/Photos/20261104_GAIS-AIK/export/`, each photo of a
  batch next to itself. `{photofolder}` is a variable of the `@ee/metadata` table, listed for the `exportFolder` context only (the folder template's picker, not the file name's; the export service is the only caller that supplies `CaptionContext.photoFolder`): the folder of the photo's
  ingested file (`dirname` of the indexed `path`, so a moved photo follows its entry). A template that
  starts with it (and only there; anywhere else is refused) is resolved by `resolveExportTarget`: the rest
  of the template is expanded, leading separators are dropped, the result is resolved against the photo's
  folder with `node:path` (the function takes the path API, so either platform's rules can be applied) and
  must be at or below that folder, or the photo fails with "the folder template leaves the photo's
  folder". Variable values are not sanitised anywhere, so a headline of `../../x`, an absolute path or
  another drive's `E:\x` in the rest is caught by this check and not by stripping. Any other absolute
  template is used as it is, and a relative one is resolved below `AppSettings.exportRoot` and may not
  escape it, as before. The photo's folder is only checked, never created: when it is not a folder (the
  drive is unplugged, the folder was moved) the photo fails with a message that names the folder, before
  anything is read or written, so nothing is recreated on another disk. A folder that cannot be created
  or written fails with a message naming the export folder. These are the same per-photo errors as any
  other export failure (`ExportJob.photos[].error`). The folder is worked out when each photo is
  exported, from the preset as it is then, so a job resumed after a restart or a preset edited during a
  job follows the preset as it stands; files exported earlier stay where they are. The exported file is
  the local path an upload is made from, as before. Deleting or removing a photo never touches its
  export folder.
- Exports below the ingest destination: an exported JPEG next to the photos must not come back as a photo.
  Every folder the app exports into that is below a photo's folder gets a `.ee-export` marker file
  (`EXPORT_MARKER_NAME` in `@ee/ingest`), except a folder that holds an indexed photo (the marker would
  hide it). A folder source (recursive) and the startup scan skip a folder with the marker and
  everything below it; the folder picked as a source, and the destination itself, are never skipped.
  `reconcileDestination` also skips a path in `exported-files.json` and any folder named `export`
  (case-insensitive, the name the default template makes). The marker lives with the folder, so
  deleting `index.sqlite`, `exported-files.json` or `settings.json` does not make exports reappear; a
  Library rebuilt from the destination holds the originals only. If the marker is lost as well, the
  folder name and `exported-files.json` still cover it; what is not covered is an export folder with
  another name whose marker and entry in `exported-files.json` are both gone, which is indexed as
  "Recovered". A real photo that was ingested into a folder named `export` is not recovered after an
  index loss either. `ifExists: 'overwrite'` and the originals check are unchanged: the target is
  compared with every indexed photo and sidecar, also those inside an export folder.
- Delete: `photos:delete` takes photo ids only. `PhotoDeleter` (jobs process) resolves the paths from
  the index. Every indexed photo is a copy under an ingest destination, except a photo in a folder
  the user added in place. The destination changes from job to job, so the current destination
  setting is not consulted. It refuses a path inside any configured card or folder source (written
  and real path, so a symlink cannot lead into one) and a photo whose path is the file it was
  ingested from (the index records each ingested photo's source file in a `source_path` column, not
  part of `Photo`; photos found by the startup scan name themselves as their source, are copies by
  construction, and have none recorded; a row made before the column existed has none either and is
  only covered by the source-folder rule). An in-place photo has `inPlace: true`, no source file
  recorded, and is deliberately allowed: Delete is the explicit trash action the user asked for,
  and every check above still applies. The sidecar
  must be the photo itself or its sibling `<name>.xmp`, and nothing may be a folder. The files go to the system trash through
  `shell.trashItem`, which only exists in main, so the jobs process sends a `trash-request` message and
  main answers by id (`shared/trash-bridge.ts`, `main/trash.ts`). There is no fallback to a permanent
  delete: when trashing fails the file and the entry stay and the photo is named in the result. A
  failure that is a lock (`EBUSY`, `EPERM`, `EACCES`, or an error with no code, which is all Electron's
  `shell.trashItem` gives and all the bridge passes on) is tried again after 150 ms and 300 ms, so three
  attempts in about 450 ms under that photo's lock only; any other code, and the bridge's own
  `ETIMEDOUT`, is final. Per
  photo, under its lock: sidecar first, then the photo, then the entry and its data (index row, camera
  and edited previews, decoded linear images, tracked preview revisions, queued exports). A leftover
  sidecar would be paired with the next file of the same name, so it must not be what a failure leaves
  behind; trashing it first means a failure there changes nothing, and one on the photo after it is
  finished by deleting again (a file that is already gone counts as trashed). Backup copies and exported
  files are never touched. Edits, labels, previews and face detection that were queued behind the delete
  find no photo (`not_found`) and write nothing; the startup reconcile ignores `.xmp` files and every
  photo it finds is a file without an entry, which a successful delete never leaves. The seen store is
  keyed on the source file, so the same card ingested again does not bring a deleted photo back.
  `EE_TRASH_DIR` (tests only) makes main move files into that folder instead of the system trash.
- Remove from Library: `photos:removeFromLibrary` takes photo ids only and is for photos whose files were
  deleted outside the app (nothing detects that; the user asks). `PhotoDeleter.removeFromLibrary` takes
  the same road as a delete after the files: under the photo's lock it drops the index row (`photos:removed`
  is emitted) and calls `onRemoved` for the cached previews, decoded images, tracked revisions and queued
  exports, and it reports each photo in the shape of `photos:delete`; an id the index no longer has counts as
  removed. **It never touches the disk**: no trash, no delete, no move, no write, and no read either, not
  even to see whether the file exists, so it works with the destination drive unplugged. The photo and its
  sidecar stay exactly as they are, and edits that were still queued behind it find no photo (`not_found`)
  and write nothing. Because the startup reconcile would index a file that is still there again (as
  "Recovered"), the removal also records the photo's path in the index database's `removed_paths` table
  (created if missing, so an older index opens), in the same transaction as the row. `reconcileDestination`
  skips those paths. When ingest indexes a new file at exactly such a path (`PhotoLibrary.add`), the
  path is dropped from the table, so the new photo is not hidden. `photos:delete` does not record a path:
  its files are in the trash, and a file that turns up there later is a new one.
  `photos:removeFolder` is the folder version for a sidebar row: an added root takes every photo
  below it and forgets itself and any added root below it; any other folder takes only its exact
  photos. Both go through the same `removeOne` road (so their paths are recorded), and the added
  root is forgotten only when nothing failed.
- On quit, main asks the jobs process to shut down (stop ingest, close the upload queue, ExifTool and
  the databases) and kills it only after a timeout.

## Settings folder

The settings a photographer wants on both computers are one folder that a sync tool can keep in
step. Each computer still keeps its own paths.

- **Two files, one `AppSettings`.** `settings.json` in the settings folder holds what every computer
  has in common. `userData/machine.json` holds the choice of settings folder and the paths of this
  computer: ingest destination, backup folder, export root, folder and card sources, folder
  destinations, profile and preset folders, panel widths. `settings:get` and `settings:set` merge
  and split them, so the renderer and every service still see one object.
- **Template paths.** A metadata template or code replacement file at or below the settings folder
  is stored relative to it with forward slashes, so it resolves on both computers. Any other path is
  stored in `machine.json` under an id and is not shown on the other computer. A `C:\…` path is
  never resolved on Linux and a POSIX path is never resolved on Windows. `settings-paths.ts` takes
  the path API, so both rules are tested on every host. `ingest.metadataTemplatePath` uses the same
  rule. A file outside the settings folder is listed only on the computer that added it. When a
  computer edits a list, references it cannot resolve (another computer's files) stay in the shared
  file.
- **Choosing the folder.** Settings → Settings folder shows the folder in use. The default is
  `userData`, so an existing install does not change. Picking an empty folder offers to copy the
  current settings and imported presets there, or to use it empty. Picking a folder that already
  holds settings adopts them, which is how a second computer joins. Nothing in the old folder is
  moved or deleted.
- **Writes.** Every write is a temp file and a rename in the same folder. Before writing, the app
  reads `settings.json` when it differs from what it last read and applies only the one change being
  made, then writes, so a change from the other computer is not overwritten. The app reads the
  folder at start. There is no watcher. Only `settings.json`, `machine.json` and the imported
  presets named `<24 hex>.json` are read, so sync conflict copies and temp files are ignored. A file
  whose `version` is newer than this app is read but never written. An unreadable file in a synced
  folder is reported and left alone rather than replaced with defaults.
- **Migration.** First run after an older version splits the old `userData/settings.json`: the
  machine file is written first, then the shared file through `settings.json.migrating` and a
  rename, and the old file is kept as `settings.json.pre-settings-folder`. A crash between the
  steps is recovered from the temp file or the backup. A missing or not writable settings folder is
  reported in Settings → Settings folder and the app writes nothing there, rather than putting
  defaults over a sync folder that is not mounted.
- **Credentials.** `credentials.json` never leaves `userData`. A synced source or destination keeps
  its `credentialRef`, but the secret behind it does not travel. Where this computer has no secret,
  the source and destination lists say "Password needed" and the form takes the password. A
  reference with no secret is a failed connection, never anonymous FTP. Only an absent
  `credentialRef` is anonymous FTP.

## Packaging and daily use

**Packages.** `pnpm dist:linux` (an x64 AppImage) and `pnpm dist:win` (an x64 NSIS installer) run
`scripts/package-app.ts`: build the native core (unless `--skip-native`), fetch the YuNet model, build
the app, run `electron-builder` with `apps/desktop/electron-builder.yml` and write to
`apps/desktop/release/`. Each runs on its own platform. The Windows installer is per user and needs no
administrator rights (`oneClick`, `perMachine: false`, below `%LOCALAPPDATA%\Programs`). There is no
signing, no auto-update and no icon of its own (Electron's is used).

- **What is in it.** `app.asar` holds `out/` and the externals of "Dependency declarations" with
  their dependencies. Programs and libraries that the operating system starts or loads cannot run
  from the archive, so `**/*.node`, `exiftool-vendored` with its platform package (`.pl` on Linux,
  `.exe` on Windows, which pnpm installs by platform) and `onnxruntime-node` are unpacked
  (`app.asar.unpacked`). Only the ONNX Runtime build of the target platform is included. The
  workspace packages are bundled by electron-vite and left out of `node_modules`. Lensfun data
  (`lensfun.json`) is imported by the renderer and the fonts by `fonts.css`, so both are inside the
  renderer bundle.
- **`resources/`.** `native/` (`index.cjs` and the addon of the platform), `models/` (the YuNet
  model) and `licenses/`. `loadCore` (`crates/core/src/index.ts`) looks for `resources/native` through
  `process.resourcesPath` first, and `findYuNetModel` looks in `resources/models` after
  `EE_YUNET_MODEL_PATH`. Under `electron .` the property exists but the folders do not, so a
  development run still resolves the workspace package and `fixtures/models`.
- **Name and data folder.** `extraMetadata.name` (`editing-experiment`, the installer's folder) and `extraMetadata.productName` make the packaged app's `userData`
  `~/.config/Editing Experiment` or `%APPDATA%\Editing Experiment`. A development run reads the
  workspace package name, so its data is elsewhere and the two never share databases or an instance lock.
- **Sandbox.** The app never disables it. electron-builder writes `--no-sandbox` into the
  AppImage's desktop entry unless `executableArgs: []` is set, which it is. The stock `AppRun` adds
  the flag itself only when `unshare -Ur true` fails, that is where the system refuses unprivileged
  user namespaces (Ubuntu 24.04's AppArmor policy). Elsewhere the sandbox stays on. The packaged
  test starts the AppImage without passing the flag and reads the desktop entry.
- **Test.** `packaged-app.e2e.test.ts` starts the AppImage (or the executable named by
  `EE_PACKAGED_APP`) with `EE_USER_DATA_DIR` set to a temporary folder. The AppImage runs with
  `APPIMAGE_EXTRACT_AND_RUN=1`, the runtime's switch for `--appimage-extract-and-run`, so no FUSE is
  needed. It checks that the app is packaged and has the package's version, the window and the jobs
  process, a raw ingested through the addon with its thumbnail, preview and linear image, a caption
  written and read through ExifTool, faces found with onnxruntime and the model, a second launch
  that exits, the default data folder name and the launcher files. Linux CI runs it in `package-linux`
  and the Windows workflow runs it against the installed app on `main` and on manual dispatch.

**Version.** `apps/desktop/package.json` is the app's version (`app.getVersion()`, `0.1.0`). It is in
`SystemInfo.appVersion`, in the tooltip of the status mark in the top bar and in Help → About.

**Single instance.** `app.requestSingleInstanceLock()` is taken before anything else starts. The lock
belongs to the `userData` folder, so a second launch on the same folder sends `second-instance` to
the first (which restores, shows and focuses its window) and quits without starting the jobs
process or opening a database. Different folders (tests, a development run) do not meet. Mock mode
(`EE_MOCK=1`) takes no lock and keeps no window state: it opens no databases and the screenshot tour
must start the same way every time.

**Window state** (`main/window-state.ts`, `main/window.ts`). `window-state.json` in `userData` holds
`{ x, y, width, height, maximized }`, the normal bounds (`getNormalBounds`, so a maximised window
keeps the size it returns to). It is written 400 ms after a resize, move, maximise or unmaximise and
on close, not while minimised or full screen. `placeWindow` takes the saved state and the work areas
of the current displays. A rectangle that shares less than 100 x 50 px with every work area (a monitor
that is gone) is dropped and the window opens at the default size and place. The size never goes
below the window's minimum. A damaged file is ignored. The file is not part of `settings.json`, which
is meant to be shared between computers.

**Logging** (`main/log-file.ts`, `main/logging.ts`, `shared/log-bridge.ts`, `shared/log-redact.ts`).
Only main writes the file, so rotation never races. `RotatingLogFile` appends lines
`<ISO time> WARN|ERROR [main|jobs|renderer] message` to `userData/logs/ee.log` synchronously, so a
line written just before a crash is kept. At 2 MB the file becomes `ee.1.log` and older ones move
down, up to five files in all.

- main: `console.warn` and `console.error` (also still printed), `uncaughtException` and
  `unhandledRejection`. Electron's error dialog for an uncaught exception is replaced by the log and
  the process carries on.
- jobs: the same bridge sends `{ kind: 'log' }` messages to main (`JobsLogMessage`). An uncaught
  exception is logged and the process exits (main restarts it, see `RestartPolicy`). An unhandled
  rejection is logged and the process carries on. `job.error` events (a failed ingest or export)
  are logged by main as errors with their scope, because they are the failures that matter day to day.
- renderer: main logs the `console-message` events of level warning and error (an uncaught exception
  or unhandled rejection in the page is a console error), `render-process-gone` and `did-fail-load`.
  Plain `console.log` is not kept.

Credentials: every line is redacted before it is written. `LogRedactor` replaces the secret values
the app has handled (the `CredentialStore` reports each secret it stores or reads, so a password is
known before the jobs process can use it) and the shapes credentials take in text: `scheme://user:pass@`
(the whole user information), `password=`, `passphrase`, `token`, `secret`, `api key`, `private key`
followed by a value, `Authorization: Basic|Bearer` and PEM private key blocks. The existing
`redactSecrets` in the ingest engine and the upload queue still cleans the messages they emit.
The call sites that log a URL, a source or a destination were read one by one: `protocol.ts` logs
the `app://` URL of a failed image request (photo id only), the jobs backend logs warnings that
contain file paths and names (settings, search index, preview check, preset and profile scans,
export and ingest warnings), the renderer logs thumbnail and template errors with the thrown message,
and `job.error` messages name the source and host. None builds a URL with user information, and all
pass through the redactor anyway. `log-credentials.test.ts` runs the credential store, the backend
and an in-process FTP server that rejects the login and prints the user and password back in its
reply, and checks that the file holds neither.

**Help menu** (`main/menu-template.ts`): Open log folder (`shell.openPath` on `userData/logs`) and
About (version, Electron and Chromium versions, data folder). It has no shortcuts.

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
  `AppStore.dispose` stops the scheduler for good and `init` builds a new one, so a store that is
  mounted again (React StrictMode in `pnpm dev`) still draws thumbnails.
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
- **Default camera profile.** A raw that names no profile is drawn through Camera Standard where one
  fits (ADR 0001), so the edited previews depend on which profile files exist. The marker
  (`<id>.edited.json`) records the default profile file the render went through; when the profile
  folders change, the backend marks the edited photos that were drawn with another default
  `previewStale` and the scheduler draws the ones on screen again (`photoUpdated`).
- **Cache busting.** `appUrl.thumb|preview(id, previewRevision)` adds `?v=<n>`. The canvas does not
  show the cached image under a crop or retouch session, where the stage is the uncropped image.

## Thumbnail and preview cache

`cache/thumb` and `cache/preview` share one size limit, 20 GB by default. Settings → Cache shows
the current use and the limit, and has **Clear cache**. The number belongs to one computer and is
kept in `machine.json` as `AppSettings.cacheLimitBytes`; it is not in the synced settings folder.

- **Reading.** Serving a cached file touches it in an in-memory map. The map is written to
  `cache/cache-usage.json` in batches, never once per read. A directory scan adds files the map
  does not know yet; it runs after the first Library paint and in small batches, so a 100,000 file
  cache does not delay startup or a folder switch.
- **Eviction.** When the total is over the limit, previews go first, oldest first, and thumbnails
  only after every preview is gone. Files written in the last ten seconds are kept, so a render
  being handed to the browser is not deleted underneath it. Every file here is disposable.
- **On demand.** A missing thumbnail or preview is made again from the photo on disk: the camera's
  embedded preview for a raw, the file for a JPEG. A thumbnail request decodes only the 320 px
  image. A photo with retouch ops is never served its camera preview; it gets a grey placeholder
  and is marked `previewStale` until the renderer stores the edited render.
- **Removal.** Delete and Remove from Library still drop every cached file of the photo.

## Library scale

The index is the source of truth for what the Library holds, not the renderer's memory.

- `photos:folders` returns the whole folder tree with counts, as stored in the index. The sidebar
  reads it, so counting 100,000 photos does not put them in the renderer.
- An index up to 2,000 photos is loaded whole, as before. A larger one opens one folder:
  `photos:list { folder }` returns that folder's photos and the grid keeps filtering, sorting and
  selecting them locally. **All photos** loads the first 5,000 of the filtered, sorted list.
- Develop on a large index gets a bounded page from `photos:query` (1,000 around the open photo),
  with tag, rating, colour, status, camera, source and text search applied and the order decided
  in the jobs process. Photo events from a running ingest or folder import still update what is
  on screen; folder counts follow.
- A photo loaded as part of a page is replaced by the full row (`photos:get`) when it is opened.
- The grid stays virtualised by rows. Scroll updates are coalesced to one per animation frame, and
  images decode asynchronously.
- `PhotoIndex` fills flat columns (`folder`, `file_name`, `capture_time`, labels, status, camera)
  from the photo on every save. Indexes: `photos_folder`, `photos_capture`, `photos_labels`,
  `photos_upload`, `photos_source` and `photos_path`. `EXPLAIN QUERY PLAN` for a folder's list uses
  `photos_folder`. An older `index.sqlite` gets the columns and indexes in place: one transaction
  fills the missing flat columns and no row is dropped.
- Measurement: `pnpm tsx scripts/measure-library-scale.ts` builds a throwaway `userData` with
  100 folders and 60,000 photos, a handful of reused generated JPEGs and search text, then launches
  the built app. It reports launch and folder times, renderer and jobs memory, scroll frames over
  50 ms, and the rows and bytes of the IPC answers. `--photos` and `--folders` change the size;
  `--keep` keeps the generated folder. Nothing in it is shipped or committed.

## Contracts (`packages/contracts`)

Key types (names are binding, fields can grow):

- `PhotoId` (string, UUID minted at ingest), `Photo { id, path, sidecarPath,
  fileName, captureTime?, camera?, sourceId, status, versions, previewRevision?,
  previewStale?, inPlace? }` (`inPlace` marks a file in a folder added in place, not an ingest copy)
- `PhotoStatus { ingest, edited, metadataDiffersFromTemplate, export, upload }`
- `SourceConfig` = `FolderSource | CardSource | FtpSource | SftpSource`
  (`FtpSource` covers FTP and FTPS; remote sources have `pollIntervalMs`,
  `remotePath`, `deleteAfterDownload` default false, `credentialRef`).
  `CardSource.discovered` marks a source created by picking a discovered card.
  `FolderSource` and `CardSource` also have optional `fileTypes` (`both` default),
  `lockFilter` (`all` default) and `incremental` (`true` default); remote sources
  have none of them. `FolderSource.watchForNewFiles` (default `false`) keeps that
  source's run scanning the folder until it is stopped; cards have no such field.
- `IngestConfig { sources, destination, backupDestination?, fileNaming,
  renameTemplate, metadataTemplatePath?, metadataTemplateMode?, developPresetId? }`;
  `fileNaming` is `keep` (the source's own file names) or `rename`; settings
  written before it existed migrate to `rename`, and `renameTemplate` is kept
  while keeping names. The template mode is `replace` (default) or `fillEmpty`. The global
  `AppSettings.metadataTemplates` and `AppSettings.codeReplacementPaths` lists
  supply the template picker and code replacement files for ingest and the
  Metadata panel.
- `IptcFields` (IPTC Core + common Ext: headline, caption, keywords, byline,
  bylineTitle, credit, source, copyright, city, state, country, countryCode,
  location, event, objectName, jobId, instructions, captionWriter, dateCreated)
- `EditParams` (mirrors Lightroom `crs:` names, e.g. `Exposure2012`,
  `Temperature`, `Tint`, `Contrast2012`, `Highlights2012`, `Shadows2012`,
  `Whites2012`, `Blacks2012`, `Vibrance`, `Saturation`, `Texture`, `Clarity2012`,
  `Dehaze`, `Sharpness` and the sharpening and noise reduction detail sliders,
  `ToneCurvePV2012`,
  crop)
- `RetouchOp` = `MosaicOp { shapes: Shape[], blockSizeRel, areas?, facePadding? }`; `areas` is
  the ordered `MosaicArea { shape, mode?: 'add' | 'subtract', enabled?, face? }` list that is
  rendered when present (`shapes` then holds the enabled adds, and is all there is in a version
  saved before `areas` existed, which loads as adds),
  `Shape = Rect | Polygon` in normalized image coordinates (0..1)
- `PhotoVersion { id, kind: 'develop' | 'retouch', ops }`
- `FolderImportInfo { jobId, root, mode: 'add' | 'rescan', state, filesTotal, filesDone,
  filesImported, filesSkipped, currentFile?, error? }`, sent as `library.progress` and
  `library.state`; `photos:addFolder`, `photos:rescanFolder`, `photos:stopFolderImport`,
  `photos:removeFolder` and `photos:listAddedFolders` are the added-folder channels.
- `photos:shiftCaptureTime { photoIds, offsetSeconds }` moves each photo from its own
  capture time and returns the updated photos with the new IPTC creation date, the ids
  left alone without a clock time, and per-photo failures. `offsetSeconds` is a signed
  whole number.
- `ExportPreset { id, name, folderTemplate, fileNaming, fileNameTemplate, ifExists, format,
  quality, colorSpace, resize, outputSharpening, metadata, stripGps, version, sendTo }`;
  `fileNaming` is `keep` (the photo's current base name plus `.jpg`) or `rename`
  (existing presets and fresh installs migrate to `rename`); `folderTemplate`
  starts with `{photofolder}` (the folder of the photo, the default `{photofolder}/export`), is
  absolute, or is relative to `AppSettings.exportRoot`, and expands `{variables}` from
  `@ee/metadata`, plus `{preset}`. A saved preset whose template is exactly the old default
  `{folder}/Export/{preset}` is moved to the new default when settings are read; an edited template is
  left alone.
- `Destination` = `FolderDestination | FtpDestination | SftpDestination`,
  with `remotePathTemplate`
- `ExportJob { id, photoIds, presetId, send[], state, photos[] }` (per-photo progress)
- `JobEvent` stream (ingest progress, upload progress, errors)
- IPC: one typed map `IpcApi` of `channel -> (args) => Promise<result>` plus
  typed event channels. Preload exposes it as `window.ee`. `LibraryFolderInfo` / `LibraryOverview`
  are the folder tree and count (`photos:folders`); `QueryPhotosArgs` / `QueryPhotosResult` are a
  filtered, sorted page (`photos:query`). `CacheStats` is the size and limit of the thumbnail and
  preview caches (`cache:stats`, `cache:setLimit`, `cache:clear`).
- `exportPresets:list/save/remove`, `export:previewTarget`, `export:start/cancel/list`, `export:render` and
  `export:rendererReady`; progress arrives as `export.progress` / `export.state`
  job events. `export:previewTarget` expands the folder and file templates exactly as the export does,
  without writing anything, so the dialog can show where the first photo would be saved. `export:render` sends the RGBA render over IPC (full-resolution only
  for `resize: none`: about 180 MB for a 45 MP Z9 frame). That is fine for the PoC
  but a known cost to optimise later (e.g. MessagePort transfer or a shared temp file).
- `settings:folder`, `settings:inspectFolder`, `settings:useFolder` and `settings:copyToFolder`
  describe, inspect, adopt and copy the settings folder. `SettingsFolderInfo` carries the path, the
  default, whether it holds settings and a `problem` when it is missing or not writable.
  `credentials:present` lists the given references that have a secret on this computer.

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

- Capture time shift (the photo menu's **Shift capture time…**): each selected photo moves
  from its own time by whole seconds. A raw is never written. Its `exif:DateTimeOriginal`,
  `xmp:CreateDate` and `photoshop:DateCreated` go into the XMP sidecar, which wins over the
  raw's EXIF from then on and is what a rebuilt index reads. A JPEG/TIFF gets EXIF
  `DateTimeOriginal` and `CreateDate`, the same three XMP properties and IIM
  `DateCreated`/`TimeCreated`. Its sub-second and offset tags stay and its modified time is
  put back after the write. The index's `captureTime` is updated and emitted as
  `photos:updated`, so sorting, the film strip, Next & send, `{date}`/`{time}` variables,
  the Metadata panel's IPTC date and exports follow at once. Photos without a clock time
  are left alone and reported. One failure does not stop the rest.
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
  tab-delimited text; variables use `{name}` syntax. The paths live in the
  global `AppSettings.metadataTemplates` and `AppSettings.codeReplacementPaths`
  lists (Settings → Metadata); the app never copies the files. Ingest replaces existing
  values by default (cameras write their own copyright/artist); "fill empty"
  is the opt-in alternative. For embedded JPEG/TIFF metadata the template's
  `copyright`/`byline` are also written to EXIF `Copyright`/`Artist`, as MWG
  requires them to agree with XMP/IPTC. Raws are never written: their EXIF is
  left alone and the template goes to the sidecar.
- Template fields (Export folder and file name, Ingest rename and subfolder,
  and the destination remote path) have a variable picker. Its entries and
  their per-context availability come from `TEMPLATE_VARIABLES` in
  `packages/metadata/src/variables.ts`; picking inserts at the caret, and the
  field reports placeholders its path cannot expand.
- Caption expansion. On blur and Ctrl+Space the whole caption goes to `metadata:expandCaption`
  (codes first, then `{variables}`, unknown ones reported and left as typed). The result lists what
  each pass replaced (`ReplacedRange`), and after Ctrl+Space the caret goes to the end of the
  replacement it was in or right after, or keeps its place in the untouched text (`mapCaret`). While
  typing, a known code is replaced after any typed edit that leaves the caret in a delimited token or
  right after one, without a round trip:
  `metadata:codeReplacementFiles` serves the configured files as text with their modified time, the
  renderer parses them with the same browser-safe module the backend uses
  (`@ee/metadata/code-replacement-tokens`) and keeps the merged set (later files override earlier
  ones). It asks again when `codeReplacementPaths` changes and when the caption gets focus; nothing
  is parsed when no modified time changed, and a file that cannot be read is reported once.
  `instantReplacement` finds the token from the caret: the delimiter just before it as a closing one
  (the token back to the delimiter before that), else the token between the nearest delimiter before
  the caret and the nearest at or after it, on one line. The code has to be known exactly (case
  sensitive), so `a=b c=d` expands only if the file has `b c`, and editing `=foo=` into `=t1=`, a
  Backspace in `=t1x=`, a Delete in `=xt1=`, or typing `=` in front of `t1=` expands it. The closing
  delimiter of an unknown token may open the next (`=x=t1=`); blur and Ctrl+Space pair delimiters
  from the left, across lines, and do not. Only a typed edit does it (`insertText` of one character,
  Backspace / Delete, also by word; never during composition): paste, drop, cut, undo and redo do
  not, so after Ctrl+Z restores what was typed nothing expands until the next typed edit. The edit is
  made with `execCommand('insertText')` so Ctrl+Z gives back what was typed.

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

- **Raw defaults.** A raw starts at Adobe Camera Raw's "Adobe Default" detail settings:
  Sharpening 40 / Radius 1.0 / Detail 25 / Masking 0, Luminance 0 / 50 / 0 and Color
  25 / 50 / 50. The camera's own `crd:` block (camera-raw-defaults) is deliberately
  ignored, matching Adobe Default; only a sidecar or preset value overrides a default
  (`readRawDefaults` in `@ee/metadata`, served by `develop:getDefaults`, never for
  JPEG/TIFF). They are not edits: the store keeps them in `editDefaults`, the sliders
  show `withDefaults(params, defaults)` and every render (canvas, edited previews,
  export) uses it, but a sidecar write holds only what the user set. An explicit `0`
  is off (so it is written), and putting a slider back on its default removes the key.
  An edited preview drawn with older defaults is discarded at startup and rendered
  again. The other camera settings in the `crd:` block are not applied either.
- **No `EXT_color_buffer_float`.** Every Chromium WebGL2 has it, but without it the
  renderer reports `supportsNeighbourhood: false`, leaves the neighbourhood settings out,
  renders the rest and calls `onNeighbourhoodUnavailable` once (the app shows one toast).
  Exports do not lose them: `renderWithFallback` (`develop-render.ts`) renders those
  settings with `renderCpu`, the same maths, up to `CPU_FALLBACK_MAX_PIXELS` (16 MP,
  about 100 bytes per pixel of float planes), and beyond that fails with a message
  saying which settings need GPU float support.

## Develop presets

Presets are Lightroom/Camera Raw `.xmp` and `.lrtemplate` files, parsed by `parsePreset`
(`@ee/develop-gl/preset`), which also reads the file's `crs:Group` and `crs:PresetType`. They come from
two places: files found in preset folders, and files imported by hand.

- **Folders** (`jobs/backend/preset-folders.ts`, modelled on `ProfileLibrary`). `defaultPresetFolders(platform,
  env, home)` is `~/Library/Application Support/Adobe/CameraRaw/Settings` and
  `~/Library/Application Support/Adobe/Lightroom/Develop Presets` on macOS, `%APPDATA%\Adobe\CameraRaw\Settings`
  and `%APPDATA%\Adobe\Lightroom\Develop Presets` on Windows (with `path.win32`, so it is testable on any
  host), and none on Linux (TODO, as for profiles). `AppSettings.presetFolders` (Settings → Presets) adds the
  user's, e.g. the `Lightroom Settings` folder next to a catalog that stores presets with it. Scans go
  to a depth of 8; `.xmp` and `.lrtemplate` only. A folder that does not exist is skipped without a word.
  The folder names come from Adobe's preset FAQ (as search results quote it) and Lightroom Queen's
  file-location guide; they have not been compared with a real install.
- **Read only.** The module makes `readdir`, `stat` and `readFile` calls and nothing else, and nothing found
  is copied. Imported presets are a separate copy in `<settings folder>/presets`. A parse is cached by the file's modified time and size (an entry read within 2.5 s of its
  modified time is read again next time, as timestamps are coarse), so a changed file is read again and a
  removed file is gone from the next scan.
- **When it scans.** Once in the background when the backend starts, and when the renderer asks with
  `develop:presetIndex { rescan: true }`: when the Develop preset list is shown, on Refresh, when Settings →
  Presets or the Ingest view opens and after a folder is added or removed. Never a timer or a watcher.
  Overlapping rescans share one more scan. Folders are scanned side by side, every filesystem call has a 5 s
  timeout, and a call that timed out is joined, not repeated, by the next scan (as `CardScanner` does). A folder
  that does not answer lists nothing and shows as a problem; it neither blocks nor fails the list. (The profile
  scan has no timeout.)
- **What is listed.** `.xmp` files with `crs:PresetType="Look"` (Adobe Color, Vivid…) are profiles and belong
  to the profile list; other preset types that are not `Normal` are left out too, neither as presets nor as
  problems. A file that cannot be parsed, is too large (4 MB) or cannot be read is a `PresetProblem` with its path
  and reason. A `.xmp` that has `crs:` settings is a preset even without `PresetType`, so a photo's sidecar in a
  folder that was added is listed as one.
- **Groups.** `EditPreset.group` is the file's `crs:Group` when it names one, otherwise the folder below
  the scanned folder (`Sport/Fotboll`). Imported presets keep the group their file named.
- **Identity.** A preset's id is the `crs:UUID` (`id` in a `.lrtemplate`), else a hash of the path;
  ids compare without regard to case. The same id found twice is one preset, and the one shown is:
  a file in a folder over an imported copy (the copy shows again if the file goes), `.xmp` over
  `.lrtemplate`, then the earlier folder and path. Different ids with the same name are all listed.
  A preset without a UUID has a path-based id, so moving its file makes it a new preset.
- **Where an id is stored.** Only `IngestSettings.developPresetId` stores a develop preset id.
  `AppSettings.activePresetId` is an export preset. `sectionStash` holds parked slider values per
  photo and section, not preset ids. Ingest asks `PresetLibrary.resolve(id)` when its first file of a job
  arrives, which scans the folders then, so the preset is the file as it is at that moment; a preset that is
  gone, or in a folder that does not answer, gives the one `preset-missing` warning and the copy goes on.
  The Ingest view says `<id> (not found)` for a saved id that is not in the list.
  Develop applies the values of the last listing when a preset is clicked (the list is read again when
  Develop is shown and on Refresh).
- **Cloud Lightroom.** Not supported: its presets live in Adobe's cloud, not in files (they can be exported as
  `.xmp` and the folder added).

## Camera profiles

A raw is rendered through a camera profile when one is available, **Camera Standard** by default when
the settings name none and a profile of that name fits the camera: DNG `.dcp` files and
Adobe XMP looks provide the camera matrices, hue/saturation tables, look table and tone
curve. The formats, parsers, matching, pipeline order, white balance, current limitations
and tests are in [ADR 0001](decisions/0001-camera-profiles.md).

## Lens corrections

Distortion, lateral CA and vignetting come from the camera's own records in Nikon Z NEFs,
with Lensfun as the fallback and manual override. They are applied in the source fetch,
before everything else, in the corrected frame. The bundled Lensfun data covers every
maker's Nikon Z and Nikon F lenses. A file with no `LensModel` uses the `LensID` ExifTool
derives from the maker notes, so third-party F-mount lenses and F-mount lenses on a Z body
through the FTZ resolve too. An ambiguous Lens ID is matched candidate by candidate and only
used when the candidates agree. The research, decision, radial model, profile choice, tiling,
retouch mapping and verification steps are in
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
have letter/F-key primaries (`Y` before/after, `F1` or Ctrl/Cmd+`/` for shortcuts, except
where that key prints `-`), and
AltGr is treated as character input so Swedish `@`, `$`, `{`… and dead keys never fire a
command. Ratings are plain `1`-`5` (0 clears); colour classes are the platform's primary
modifier plus `1`-`8` (0 clears), falling back to `event.code` when a layout changes the
digit under the modifier.

## Crop mode

Crop mode follows Lightroom Classic's Crop Overlay model. The crop frame is always an
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
  resize; inside the frame pans the image, or, while the photo is uncropped (the frame is the
  whole level image), draws a new frame like the Frame tool; anywhere outside rotates about the frame
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
  cleared in crop mode); they show again after Done.
- **Modifiers**: Shift toggles the aspect lock for the drag (a Free crop locks to its own
  ratio) and snaps a rotation to 1°; Alt/Option resizes or draws about the centre.
- **Overlays**: rule of thirds while interacting or hovering, a finer grid while
  rotating, `O` cycles thirds, grid, golden ratio, none.
- **Keys**: `C` enters (and applies), `Enter` (Done, unless a typed value or a keyboard-focused
  button has it) or a double-click inside the frame applies, `Esc` cancels, `X` swaps orientation, `Ctrl/Cmd+Alt+R` resets, double-click on
  the angle slider resets the angle. The angle is also typeable: a comma or dot decimal
  works, Enter or blur commits and stays in crop, and Escape leaves the field (committing
  through its blur) without cancelling the crop.
## Zoom and pan

The photo view is Fit until the user zooms. Zoom is view-only: it never reaches a sidecar, the
edited previews or the export, and the develop shader is the same one.

- **State** (`renderer/zoom-view.ts`, an external store like `develop-view.ts`): a `ZoomView`
  (`scale` in CSS pixels per picture pixel, `null` for Fit, and a `pan` from where Fit puts the
  picture) belonging to one photo *and* mode (`zoomKey`), so switching photos, or entering or
  leaving crop and retouch, starts at Fit. The level `Z` goes to (50 / 100 / 200 %, 100 % to
  start) and whether Space is held live there too.
- **Maths** (`renderer/view-transform.ts`, pure, unit tested): `viewLayout` (picture to CSS pixels),
  `zoomTo`/`zoomBy` about an anchor, `panBy`, `clampPan`, `wheelZoomFactor` and `wheelPanDelta`.
  A picture smaller than the canvas on an axis stays centred on it; a larger one pans until its
  edge is 64 px inside the canvas. Zoom is limited to Fit (below) and 800 % (above), in device
  pixels. `wheelPanDelta` negates the wheel delta (scrolling down moves the view down the photo),
  uses both axes, turns line and page deltas into pixels like `wheelZoomFactor` does, and makes
  Shift pan sideways even where Chromium sends it as a vertical delta.
- **Pixel grid.** A layout at 100 %, 200 % (a whole number of device pixels per picture pixel) or
  50 % has its offset rounded to whole device pixels (`viewLayout(…, dpr)`, `snapToDevicePixels`):
  at 1:1 a half-pixel offset makes the LINEAR texture filter average neighbouring pixels, so a
  focus check would be soft, while on the grid linear and nearest give the same pixels and the
  sampler stays LINEAR. The stored pan is never rounded (the zoom maths anchors to the unrounded
  layout), so pans do not accumulate error. The snap only holds if the stage's own corner is on
  the grid, so a stage that fills the canvas (zoomed, crop) is pinned to the canvas area's corner
  (not flex-centred) and sized to whole device pixels (`wholeDevicePixels`), which also makes the
  drawing buffer exactly the stage. Fit and non-integer zoom stay smooth. A canvas wider than the
  4096 px buffer cap is drawn scaled, and is not 1:1.
- **Picture.** The picture is what the view shows in full-resolution pixels: the committed crop's
  output in Develop, the whole image in Crop and Retouch. 100 % is one of its pixels per device
  pixel, so `Z` on a 2x display is a layout scale of 0.5.
- **Drawing** (`PhotoCanvas`, `renderer/zoom-render.ts`): while zoomed the stage is the whole canvas
  and the GL canvas is drawn with `renderer.renderView`, the transform crop mode already uses, with
  the committed crop (or the whole image) as its frame (`pictureViewTransform`), so the shader,
  lens corrections, vignette and neighbourhood passes are the develop render's own. Fit still
  uses `render`. `renderSplit` takes the same optional view, so both sides of a before/after
  split zoom together. Crop mode composes the zoom into its layout, so the frame and handles
  (`CropOverlay` takes the layout) and the canvas agree at any zoom.
- **Resolution.** At Fit the linear image is sized for the screen (up to 2560 px). Zoomed, the
  canvas asks `app://linear` for `linearEdgeFor(device scale)`: steps of 2560, 4096, 6144 … then the
  full-resolution decode (no `maxEdge`, the one the export reuses), and never more pixels than the
  image has. The drawing buffer is the canvas (up to 4096 px), so 100 % is sharp.
- **Overlays.** Pointer positions go through the layout (`pointOnPicture`); the retouch SVG's
  viewBox is the part of the picture in view, so shapes, face boxes and lassos stay where they
  are. The click, minimum-size and lasso-simplify tolerances are fractions of the picture at Fit
  and shrink with the zoom, so they stay a few screen pixels. The mosaic over a zoomed view is
  applied to the pixels just drawn (`mosaicZoomedView`): shapes are moved into buffer space and the
  block size scaled with them, so a block covers what it covers in the export. The block grid is
  anchored to the canvas, so blocks shift while panning. The histogram is not re-measured while
  zoomed. The white balance picker maps through the layout like the retouch overlay.
- **Keys** (`zoom-keys.ts`, `keyboard.ts`): `Z`, Ctrl/Cmd + `+`, `=` or numpad `+` and Ctrl/Cmd + `-`
  or numpad `-` match `event.key`, never `code`, as on a Swedish keyboard `+` and `-` sit on the
  physical Minus and Slash keys. That is why the shortcut list's Ctrl/Cmd+Slash does not fire where
  the Slash key prints `-`. AltGr never zooms. Ctrl/Cmd+Wheel and a trackpad pinch (a Ctrl+wheel
  to Chromium) zoom about the pointer. A plain wheel pans a zoomed view, on both axes (Shift
  sideways), and is left alone at Fit; it only moves the view, so the active crop or retouch tool
  stays active. Space (never in a text field, Ctrl+Space excluded) puts a pan layer over the
  active tool: a drag pans and nothing else sees the pointer, and Space is released on key up or
  window blur. **Ctrl/Cmd+0 is not Fit**: it clears the colour class, which has no other clear, so
  Fit is `Z` or the footer.
- **Electron.** `main/menu-template.ts` is Electron's default menu minus the View menu's zoom roles
  (they bind Ctrl/Cmd+0, `+` and `-` to page zoom), and `setVisualZoomLevelLimits(1, 1)` turns
  off pinch page zoom.

## Culling a burst

The Library loupe (`E`) and Develop are made to move through a burst quickly. What changes with
the photo on screen is bounded and never delays it.

- **Zoom in the loupe.** The loupe uses the model of "Zoom and pan" (`zoom-view.ts`,
  `view-transform.ts`, `zoom-keys.ts`): `Z`, Ctrl/Cmd `+` and `-`, Ctrl/Cmd+wheel and pinch, a plain
  wheel, Space+drag and the Fit and level buttons, which sit in the filter row's slot because the
  loupe has no footer. Fit shows `app://preview` exactly as before. Zoomed, the picture is the
  camera's full-size JPEG (`LibraryLoupe`, `loupe-view.ts`), drawn by an `<img>` placed by the same
  layout maths, so no raw is decoded and no WebGL is used. 100% is one JPEG pixel per device pixel
  and sits on the pixel grid (`viewLayout(…, dpr)`, `image-orientation: none`, a stage of whole
  device pixels), checked at device pixel ratios 1 and 1.25. A photo without retouching zooms into
  the whole camera frame, not developed and not cropped, so a develop crop is not seen once zoomed.
  Until the JPEG has loaded the edited preview is stretched into its place, unless its shape is
  another one (a crop).
- **`app://full/<id>`** (`FullImageCache` in `jobs/backend/full-images.ts`). A raw gives its largest
  embedded preview (`extractPreview`, read by LibRaw), a JPEG gives the file. Upright bytes are
  written to `cache/full/<id>.jpg` as they are, a turned one is decoded, turned and encoded once
  (quality 92). A JPEG's orientation is the tag in the file (`jpegExifOrientation`), never the index's. A format with no JPEG (TIFF, PNG, HEIF) answers 404 and the loupe keeps the preview.
  The cache holds at most 32 files and 512 MiB, least recently used first, is emptied at start and
  forgets a deleted photo. Nothing is written beside the photo.
- **Privacy.** The camera JPEG shows what a retouch hides. A photo whose newest retouch version has
  ops gets exactly what `app://preview` gives it from `PreviewCache.resolve`: the edited preview
  drawn with the current ops, and a grey placeholder (`no-store`) until it exists. The camera file
  is neither built nor served for it, also when it was cached before the retouch was made. Its URL
  is `app://full/<id>?v=<previewRevision>` (0 when absent), which a retouch change bumps, so the
  `<img>`, the preloader's images and the browser cache never answer it with the camera image. The
  preloader drops what it held for a neighbour whose URL changed. The loupe
  then zooms into that image at the resolution it has, in a frame of the camera's size so the zoom
  levels mean the same part of the frame.
- **The zoom carries.** The loupe's zoom belongs to the loupe, not to a photo (`LOUPE_ZOOM_KEY`), so
  an arrow key keeps the level and the position. Leaving the loupe returns to Fit. Develop is
  unchanged: a new photo starts at Fit.
- **Loupe preload** (`image-preloader.ts`). Once the photo on screen has its image, the next and the
  previous photo's image at the current need (the preview at Fit, `app://full` zoomed) is fetched
  and decoded ahead with `Image.decode()`. At most two such images are held, and one that is no
  longer wanted is dropped at once, cancelling its request if it has not finished. A request already
  in the jobs process cannot be recalled, but it only fills the bounded cache above.
- **Develop preload.** With the photo on screen loaded, `PhotoCanvas` asks for the next and the
  previous photo's linear image at Fit size with `app://linear/<id>?maxEdge=N&warm=1`. The jobs
  process decodes it into `cache/linear` and answers 204 with no body (`x-ee-warm: ready`, or
  `dropped`). A warm decode starts only while no decode for the photo on screen is running, one at a
  time, and at most two wait: a newer request pushes the oldest waiting one out, so what belongs to
  a selection the user has left is dropped, not decoded. A decode that has started finishes into
  the cache. That cache keeps at most 6 decoded images and 1.5 GiB.
- **One canvas for Develop** (`develop-canvas-host.ts`). The store's host makes one `<canvas>`, one
  WebGL2 context and one `DevelopRenderer` on first use and keeps them for the life of the window,
  also while the module is left. `PhotoCanvas` still mounts a tree per photo, but it puts the host's
  canvas into a `display: contents` slot of that tree (the node is not React's), gives the renderer
  the photo's grain seed and context-loss callback (`DevelopRenderer.configure`), and calls
  `release()` when the photo goes. `release()` deletes the source textures, the neighbourhood
  stages and every pooled float texture (`ImagePool.trim`, also called by `setImage`), and the
  histogram target, and clears the drawing buffer. The context, the compiled programs and the
  curve and profile tables stay. The canvas is hidden until the new photo's first frame is drawn,
  as before, and the preview image shows meanwhile, so nothing of the last photo is on screen.
  The textures and framebuffers alive are the same after any number of photos (a browser test
  counts them over photos of many sizes), and a photo drawn after others is byte for byte the
  photo a fresh canvas draws (an e2e compares the compositor's pixels). Context loss is as before
  for the photo on screen: the renderer rebuilds its resources when the context is restored and the
  photo clears its lost flag from the `webglcontextrestored` event. A dead context costs one photo
  and no more: when a photo mounts and the host has an error (the context could not be made) or its
  context is still lost, the host disposes the renderer and the photo gets a new canvas and a new
  context. A resize of a canvas that has a context stalls on software GL (about
  0.3 s), so the canvas is not sized before its area is measured, and a photo whose stage differs
  in size from the last one pays that once.
- **Auto-advance** (`AppSettings.autoAdvance`, off by default). With it on, `T`, `1`-`5`, `0` and the
  colour keys on a single photo in the loupe or in Develop move to the next photo of that view's
  list, worked out before the change so a filter that hides the photo cannot skip one. It does not
  apply to a multi-selection, in the grid, on the last photo or while a crop or retouch session is
  open. The switch is in the filter row of the loupe and of Develop.

## Develop undo, redo and Reset all

Develop keeps one undo and redo history per photo, in the renderer for the session only. It is not
saved and is gone on restart. `renderer/develop-history.ts` holds the steps. Each step is the
photo's `EditParams` before and after a change (absent keys stay absent) plus the values parked by
switched-off sections, so an undo restores a section switch with its settings.

- **One writer.** Every change to a photo's develop settings goes through
  `AppStore.writeDevelopSnapshot` (`renderer/store.ts`), the only code that publishes a user change
  to `AppState.editParams`. Slider and typed values, resets, curves, the colour mixer and grading,
  presets, Auto tone, Auto WB, the WB picker, profile and lens settings, a committed crop, Paste,
  Previous, Sync, section switches and Reset all all call it (the slider and less common writers
  through `patchParams` or a dedicated wrapper). A backend read (`loadParams`) and a batch result
  from `develop:applySettings` are the only writes that do not come from a user change. The batch
  result records one step per affected photo. A new kind of change cannot publish parameters
  without going through that method, because `AppStore.set` does not accept `editParams`. A
  sidecar read records nothing. When it differs from the settings the history expects, the photo's
  history is dropped, because those steps no longer describe the sidecar. A read that is behind a
  local write still in flight is ignored instead.
- **One gesture is one step.** A window `pointerdown`/`pointerup` pair in `renderer/keyboard.ts`
  opens and closes a gesture, so every change of a drag (slider, colour wheel, tone curve) coalesces
  into the step the first frame opened. A typed value opens a gesture on focus of the slider's field
  and closes it on blur, so its live applies and the commit are one step. Arrow-key steps call the
  `nudge*` writers: changes to the same parameter within 600 ms are one step, and a pause starts a
  new one. A gesture never merges into the step before it. Pointer cancel, lost pointer capture,
  window blur, Escape and a photo or module change also close it, and a slider that unmounts closes
  its typed edit.
- **Undo and redo.** `Ctrl/Cmd+Z` undoes and `Shift+Ctrl/Cmd+Z` or `Ctrl/Cmd+Y` redoes in Develop, on
  the open photo only. A pending throttled save is dropped and the restored settings go through the
  normal save path, so the sidecar, the canvas and `EditedPreviewScheduler` follow as for any edit.
  Undo and redo also wait for a Paste, Sync or Previous on that photo to settle, so its step exists
  before the undo takes it back, and the sidecar never ends with the batch result afterwards.
  A new change clears the redo steps. In a text field the keys keep their native text undo. During
  Retouch, `Ctrl/Cmd+Z` keeps stepping through the session's areas. During Crop, undo and redo are
  ignored: the draft crop is saved as one step on Done, so its own gestures never mix with the
  develop history.
- **Bounds.** At most 100 steps per photo. The renderer keeps histories for at most 200 photos and
  drops the least recently edited. Deleting or removing a photo drops its history. Retouch,
  metadata, ratings, labels, tags, zoom and view toggles are not in it.
- **Reset all.** The Develop panel's `Reset all` button writes an empty parameter set and clears the
  section parking, in one step. The sidecar holds no `crs:` settings again, raw defaults apply, and
  the crop is back to the whole image. It does not touch retouch or metadata.

## Copy, paste and sync develop settings

Lightroom-style settings transfer. The groups are defined once in
`packages/contracts` (`DEVELOP_SETTING_GROUPS`, one entry per `EditParams` field;
a contract test fails when a new field is not assigned). Crop is in the list but
off by default. Retouch is not a develop setting, so it is never copied; mosaics
stay with each photo.

- **Copy settings** (`Shift+Ctrl/Cmd+C`) opens the group dialog for the active photo and
  remembers its settings (as shown, including raw defaults) with the chosen groups. The
  dialog opens with the groups last confirmed there (Copy or Sync), or the default groups
  when none was saved; Cancel/×/Esc leave that stored choice alone. The choice is global
  and lives in settings, not per photo.
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
- A batch paste is one backend write, and each affected photo gets its own step in its develop
  history (see "Develop undo, redo and Reset all"). `Ctrl/Cmd+Z` only changes the open photo.

## Metadata templates and Copy/Paste metadata

Settings → Metadata is the global home of Photo Mechanic metadata templates and code
replacement files, like Photo Mechanic itself. `AppSettings.metadataTemplates` is an
ordered list of `.XMP` paths (the app never copies the files) and
`AppSettings.codeReplacementPaths` is used everywhere captions expand: ingest, the
caption/metadata fields and batch caption. The Ingest view keeps its own template
choice (a dropdown over the global list, plus None and Browse…) and the Replace / Fill
empty mode. Loading settings written before this split migrates
`ingest.metadataTemplatePath` into the global list (keeping it selected for ingest) and
moves `ingest.codeReplacementPaths` to the global list.

The Metadata panel (Develop) has a template select over the global list, or a link to Settings → Metadata
when the list is empty; templates are added there, not in the panel. **Apply** targets the whole
multi-selection in the film strip (or the open photo), and applies Fill empty; the small menu beside it
also has Replace all, labelled as overwriting, which applies at once and is not remembered. The panel does not
read the template mode of Settings → Ingest, whose Replace default suits what cameras write at ingest, not a
caption written by hand. Credits, Location and
Event / job are folded, with their values and `≠ template` on the header; the open groups are kept in
`metadata-view.ts` for the session and not saved.

**Copy** opens a field picker grouped like the panel sections (Caption, Credits,
Location, Event / job). It snapshots the checked fields from the active photo, including
explicit empty values, in `AppState.copiedMetadata`. The picker opens with the fields last
confirmed there, or every field when none was saved; Cancel/×/Esc leave the stored choice
alone. The choice is global and lives in settings, not per photo. **Paste** writes exactly
that partial field set to the selected photos through `metadata:writeFields` (the normal
`writeIptc` path, so raws go to their XMP sidecar and are never written), independent of
what is ticked later. Fields that were not copied stay untouched and code replacements are
not re-expanded on paste. `metadata:writeFields` also refreshes each photo's
`metadataDiffersFromTemplate` status.

## Export model

Three actions share one model: Export… (preset into a local folder, by default `export` next to the photo), Export & send
(the same, then upload the exported files) and Next & send (one photo with the active
preset, then advance). A batch runs in the jobs process; the renderer stays usable.
`ifExists` picks suffix/overwrite/skip. Metadata modes write IPTC/XMP, optionally
copy camera EXIF and GPS from the original, or only copyright; `stripGps` drops the
location tags.

`all` copies the original's `DateTimeOriginal`, `CreateDate`, their `SubSecTime*` and
`OffsetTime*` tags, so burst order and the camera's UTC offset survive. The copied EXIF dates
are then assigned the index's current `captureTime` in the same ExifTool write, so a shifted
raw exports with its shifted time and no extra date tags are added. No `ModifyDate` or XMP date names the export time. A tag copy that updated nothing (a source ExifTool cannot open) fails
the export instead of leaving a JPEG without them. `iptc`, `copyright` and `none` carry no camera
EXIF, so no EXIF dates (`iptc` still writes the IPTC/XMP creation date taken from the original).
In `all` and `iptc` the exported file's modified time is set to the photo's capture time, as the
last step before the file is published (ExifTool's rewrites reset it, the rename keeps it); the
access time stays at the export. A zone-less capture time (a raw has none) is read with the
original's `OffsetTimeOriginal` when it has one and as this machine's local time otherwise, never
shifted by hours. With no capture time, or only a date, the time is left as the export time, as it
is in `copyright` and `none`. Failure to set it is a warning, not a failed export. Nothing reads
the exported file's modified time (the upload queue uses its size), and uploads do not carry it. Output sharpening is a simple luminance unsharp mask applied after
the resize (normally a no-op), in the jobs process, before encoding. `Photo.status.export`
is saved in the index (`done` survives a restart; `rendering`/`encoding` are transient),
and the film strip and Library grid derive queued/running badges from the export jobs.

**Next & send** moves on first and exports in the background (`AppStore.nextAndSend`).
Whatever can be refused without waiting (no photo, no preset) is refused where the user is, with
a toast, and nothing moves. Otherwise the selection moves to the next photo of
`getVisiblePhotos()` as it was at the press (the last photo stays, and a filter that changes
later cannot skip or strand the move), and each press hands one job to the jobs process, in
press order and one `export:start` at a time, so the upload queue (oldest first) sends in the
order the photos were pressed. A draft crop is applied and unsaved mosaic shapes are saved by
`select` first, as for any navigation. The jobs process renders one photo at a time and asks
the renderer for each render when its turn comes. That render draws in a worker from the
store's own copy of the photo's settings (read from the sidecar when the store has none yet),
so it does not need the photo to be open and does not touch the canvas, crop or retouch
session on screen, and it first writes any debounced metadata and settings for that photo, so
edits made just before the press are in the export however slow their save was. A photo whose
earlier Next & send has not been rendered yet ignores another press (a double press, or the last
photo, where the selection does not move); `Ctrl/Cmd+Enter` ignores key repeat. Once the job is
past its render, the photo can be sent again. A job that fails after the user moved on is a
toast naming the file (`Could not export <file>: <reason>`) and never changes the selection; a
failed upload stays in the failed-uploads list in the top bar.

On quit the jobs process closes the export queue: the photo being rendered goes back to
`queued`, every unfinished job stays in `export-jobs.json` and carries on after the next launch
once the renderer calls `export:rendererReady`, rendering from the edits saved by then. In-flight
uploads are requeued from `uploads.sqlite` the same way. There is no quit dialog. A press whose
job had not been handed to the jobs process yet (the moments it takes to save the edits) is lost,
and a resumed job that fails shows no toast, only its photo's failed status.

**Upload queue.** One row per file and destination in `uploads.sqlite`, oldest first. A
destination that cannot be reached right now is a connection outage: connection refused,
reset, timed out, DNS or network unreachable, or a control or data connection that drops
mid-transfer, for FTP, FTPS and SFTP. The row becomes `waiting` with a short plain reason and
does not use up an attempt. Only the oldest row of that destination probes the connection,
after a wait that doubles from `retryBaseDelayMs` and stops at `retryMaxDelayMs` (30 s), so a
down server is not hammered by the whole queue. The other rows of that destination wait with
it, and other destinations keep sending. When a probe succeeds, the waiting rows are released
oldest first. A failure that will not fix itself (wrong login, permission denied, a path that
cannot be created, a missing local file, an existing remote file) keeps the rule of
`maxAttempts` (5) and then `failed`. `waiting` is stored in the queue database, so a restart
keeps it. A database written before the state existed opens as it is. The upload popover and
the top bar show "Waiting for connection" apart from "Failed", and a waiting item can be
cancelled. A photo's thumbnail badge stays Queued while its upload waits. A queued row keeps
its own copy of the destination, so removing that destination from settings does not fail
rows that are already waiting.

The renderer draws at the final output size so a 1600 px export never renders a
45 MP raw. `outputSizeForResize` is the one definition of that size: the renderer
uses it on the crop's pixel size and the encoder uses it to decide whether its own
resize is needed. Neighbourhood radii are in full-resolution source pixels and
`blockSizeRel` is relative to the image edge, so the smaller render has the same
look; a browser test compares a 2048 px direct render with a full-resolution
render downscaled to 2048 px.

## Retouch editing

A retouch session (`AppState.retouch`) edits one ordered list of areas (`renderer/retouch-areas.ts`):
rectangles, lassos and detected faces, each added or subtracted and each on or off. A subtract takes
mosaic away from everything before it and a later add covers the area again (`applyMosaic` follows the
list order). A face keeps the detector's box next to its padded outline, so it can be switched on and
off and re-padded after a resume; the padding is stored as `facePadding`. Saving writes the whole list
into the version's `MosaicOp`, and re-entering Retouch loads it back (a version without `areas` loads
its shapes as editable adds, wand outlines from before that tool was removed included). The toolbar's
block size and face padding sliders also take typed values in the same units (px while the photo's
size is known, % otherwise; % for padding): a draft commits on Enter or blur, is clamped to the
slider's range and is discarded when it is empty or invalid.

- **Tools.** Retouch always opens on Faces in Add mode; nothing is remembered from the last session.
  Faces searches the rectangle that is dragged, or, with Alt held as the drag starts, a lasso's bounding box and
  keeps the faces centred inside the outline, and adds to the faces already there. In Subtract mode the same area deletes the face areas centred inside it instead (one undo step, no detection, no subtract shape). Removing every area of a saved version removes the version.
- **Gestures.** Drawing adds an area in the current mode; with Rectangle or Lasso, Alt held at the start of
  a drawing flips the mode for that drawing (with Faces it picks the lasso instead). AltGr never counts. A click on an area switches the topmost one under it on or
  off. Undo steps back through drawing, detecting and switching. Esc drops a shape being drawn, or
  otherwise saves and leaves; `Enter` and the toolbar's Done do the same (Enter not while a typed value or
  a keyboard-focused button has it). The photo footer's **Delete retouch…** removes the newest retouch
  version after a confirmation (`AppStore.deleteRetouch`).
- **Drawing from outside.** A drag may start in a margin of 24 CSS px around the picture
  (`renderer/retouch-margin.ts`, `HIT_MARGIN`), so an area can reach the very edge. The overlay SVG
  covers the picture plus that margin, cut off at the canvas area (never over the toolbar or the
  panels), so a side where the picture fills the canvas has none. Retouch's Fit leaves
  `2 * HIT_MARGIN` around the picture (`fitWithin`'s `margin`; Develop keeps 32), so the margin
  exists at Fit too. Every point of a drag, its start, moves and end, is clamped to the picture
  (pointer capture keeps the moves coming outside the margin and the window), so stored coordinates
  stay in 0..1. A click that starts in the margin, or a lasso that never touches the picture,
  adds and toggles nothing and runs no detection. Space held leaves the margin to the pan layer.
- **Rendering.** Mosaic is a CPU pass after the develop render. The canvas preview
  (`renderer/retouch-preview.ts`), the export and the thumbnail (`composeDevelopedRgba`) all call
  `applyMosaic` with the same op, and `mapMosaicShapes` moves areas through lens correction and crop
  in step with their shapes. The ops key (`retouchOpsKey`) is the JSON of the ops, so a toggle or a
  subtract changes it and an export of a stale render is refused as before.

## Renderer shell

`App.tsx` renders the top bar and one module view (`AppState.module`: `ingest`, `library`,
`develop`; Retouch is the Develop view with `AppState.retouch` set). `D`, `G` and `E` switch
modules (`keyboard.ts`); leaving Develop applies an open crop and saves a retouch session first.

- **Hidden panels.** `Tab` (`AppStore.togglePanels`, not in a text field, select or dialog, not `Shift+Tab`)
  hides the side panels in the Library and the side panels, filter row and film strip in Develop.
  `AppState.panelsHidden` is that view's state, shared by both and kept in memory only (not in settings),
  so a restart shows the panels. Retouch and Crop open with the panels hidden: while a session is open
  `panelsAreHidden` follows `focusPanelsShown` instead, which each new session resets and `Tab` flips, and
  `panelsHidden` is not touched, so leaving shows the view that was there before. Hidden panels stay
  mounted (the `hidden` attribute and a zero-width grid column), so they keep their scroll and folded
  sections, and the canvas's `ResizeObserver` refits. Hiding writes pending caption and keyword edits first.
Design tokens and component rules are in `docs/DESIGN.md`.

- **Library state** (`AppState.library`, `renderer/library.ts`): the folder and the thumbnail size.
  The filters are not Library state: see "Filters". The multi-selection is the shared `AppState.selection`
  (also used by the film strip and the export actions); a grid click is `select(id, mode)` with
  `replace`, `toggle` (Ctrl/Cmd) or `range` (Shift), where a range follows the grid's order in the
  Library and the film strip's elsewhere. The last clicked photo is `selectedId`, the one the
  inspector and Develop show. Tag (`T`), rating (`1`-`5`, `0` clears) and class
  (Ctrl/Cmd+`1`-`8`, `0` clears) act on the selection in the Library and on the open photo
  elsewhere, in one `photos:setLabels` call. Export… and Export & send
  use `openExportDialog` and `exportSelected(true)`.
- **Filters** (`AppState.filter`, `renderer/filters.ts`, `components/FilterBar.tsx`): one `FilterState` for
  the Library and Develop, in memory only (a restart starts unfiltered; panel widths are the only
  persisted UI state). It is AND between filters: tag (`all`, `tagged`, `untagged`), `minRating`
  (0 off; star N means "N and up", and unrated photos are out while it is on), `colorClasses`
  (several, OR), `statuses` (several, a photo must match every ticked one: Not sent, Failed, Edited,
  Metadata differs), `camera` and `sourceId` (one each, the Camera menu's two groups) and `search`.
  `filterPhotos` is pure; `filterCounts` gives the numbers beside the options as "what this option
  would show with the rest of the filter kept". The Library list is its folder (library state), then
  the filter; Develop's list (`getVisiblePhotos`, the film strip, arrow keys, Next & send) is every
  photo, then the filter. Sort (`AppState.sort`) is global too, not part of the filter or Clear; it
  defaults to capture time, keeps a same-second burst in natural file-name order and puts photos with
  no capture time last, again by file name.
  **A hidden active photo** (a filter change, or a rating, class or tag change in Develop) follows one
  rule, `ensureSelectionVisible`, on the list of the module on screen: the selection keeps only the
  photos still shown; if the active photo is hidden the first shown photo becomes active and the
  only one selected; with nothing shown there is no active photo and the empty selection. The Library
  does not re-check after a label change, so the photo you just rated stays selected until the
  next filter change. Clearing the filter selects the first photo again.
- **Search** (`photos:search`, `SearchIndex` in the jobs process, `@ee/metadata/search`). The renderer only
  has a photo's caption and keywords for the photo it has open, so the text is kept in the jobs
  process: a map in memory, mirrored in `index.sqlite` (`photos.search_text`, NULL until read) so a
  restart does not read every sidecar again. A background queue (two ExifTool reads at a time)
  fills it for new photos, for every photo of an index made before search existed, and again after a
  caption or keywords are written (metadata write, apply template). A query is a substring test per
  photo in memory. Matching is case-insensitive with `å`, `ä`, `ö` kept distinct from `a`, `o`
  (NFC on both sides), every word of the query must be somewhere in the file name, caption or
  keywords, and the sidecar stays the source of truth: a caption changed by another program is
  seen when that photo is next written here. Each read runs under the photo's lock
  (`PhotoLibrary.withLock`), held for that one read only, so it cannot overlap a delete or a
  metadata write (on Windows a file open for reading cannot be moved); a photo that is gone by the
  time its turn comes is skipped without a log line. The answer carries `pending`, the photos not read yet
  (they match by file name only); while it is above 0 the store asks again every second. The store
  also asks again 400 ms after photos arrive or a caption is written, so the result does not go
  stale. The bar debounces typing 250 ms; an answer for older text is dropped.
- **Inspector** (`LibraryInspector`): one selected photo shows its file facts and editable caption
  and keywords; several show the count, the values they share and `Differs` where they do not
  (`selection-summary.ts`), read-only, with Edit… buttons into the batch caption dialog (`ensureMetadata`
  reads the fields of up to 100 selected photos for the comparison).
- **Folders** come from the index's `photos:folders` (`libraryFoldersFromInfos`): the folder of
  each photo's `path`, which is the ingest copy or a file in a folder added in place, plus every
  added root even when all its photos are in subfolders. A small index still derives them from the
  loaded photos (`libraryFolders`). An added root's count is every photo below it. Sources are
  not consulted. Two folders with the same name in different roots show the shortest parent suffix
  that tells them apart. **Add folder…** opens the picker and starts an added-folder run; a folder
  row's right-click menu has **Rescan folder** when it is an added root and **Remove folder from
  Library…** always. The latter asks first, states the row's count and that files on disk are not
  touched; on an added root it removes the whole tree and forgets the root and any added root below
  it, while on any other folder it removes that folder only. Running runs show their count and a
  Stop button under the list. An added folder is worked on where it is: edits write XMP sidecars and
  JPEG metadata in that folder.
- **Delete** (`AppState.deleteRequest`): the Delete key (and Backspace on macOS, where the "delete" key
  reports it) and a right-click menu on the grid and the film strip with Tag, a rating row and a class row
  (the same `toggleTag`, `setRating` and `setColorClass` as the keys, so they act on the whole Library
  selection) above "Shift capture time…", "Delete…" and "Remove from Library…" (the menu measures itself to stay inside the window). Both act on
  the Library's selection and on the open photo in Develop; a right-click on a photo outside the
  selection selects it first. It does nothing in a text field, behind a dialog, in Ingest or during crop
  and retouch. A dialog states the count and that the files go to the system trash; Enter confirms, Esc
  cancels. "Remove from Library…" has no shortcut and opens the same dialog in the `library` mode
  (`DeleteRequest.mode`): it states the count and that files on disk are not touched while the photos' edits
  and ratings in the app go, and it calls `photos:removeFromLibrary`. Photos the backend reports as deleted leave the list, the selection moves to the next photo
  (the previous one at the end), Develop returns to the Library when none is left, and the renderer
  drops what it kept for them: pending debounced saves, cached metadata and settings, a crop or retouch
  session, scheduled thumbnails. Photos that failed stay and are named in an error.
- **Batch caption** (`applyFieldEdits`) reads each photo's fields (`metadata:read`), merges the
  edits (replace, or append: text after a space, keywords as a union; `mergeFieldEdits`) and
  writes with `metadata:write`. Caption codes and `{variables}` are expanded per photo.
- The grid virtualises by rows from the scroll offset and reports its visible photos to the
  edited-preview scheduler like the film strip does.

## Ingest view

`IngestView` is one sentence read left to right: copy **From** these sources **To** that folder, with a
bar that always holds the one action. It owns the form that Settings → Ingest used to be (that tab is
gone); Settings keeps Sources, Destinations, Metadata, Profiles and Presets.

- **From** (`IngestFrom`): cards found on their own, then folders and servers from Settings → Sources,
  as one list. Every row has a tickbox, a name, the card's image count or the source kind on the right and
  one detail line (location, then the filters that are not the default, or `all files`). The detail line of
  a folder or card opens that source's filters inline (`SourceFilters`: file types RAW / JPEG / All, lock
  Locked / Unlocked / All, Skip already ingested, and for a folder Watch for new files); each click saves
  the source. A run adds its progress, Stop, warning and error under the row. A watching folder reports
  `watching` with its count there, like a polled server. Cards are scanned when the view opens and by Rescan, never on a
  timer; ticks are in memory only (`pickedCards` for discovered cards, which start unticked and are
  dropped when the card leaves; `unpickedSources` for folders and servers, which start ticked, as they
  were always ingested). A removed card whose run is going or failed stays until dismissed.
  `+ Folder or server` opens Settings → Sources.
- **To** (`IngestTo`): Folder, Subfolder, File names, the Rename template when renaming, Backup, then a
  preview, then Apply on the way in: Template (with Replace / Fill empty once one is chosen) and Develop
  preset. `TemplateField` has an `inline` layout for the `{ }` picker inside the field. Two columns when
  the column is wide, one when it is not.
- **Preview.** `ingestPreview` (`renderer/ingest-preview.ts`) calls `previewIngestPath` from
  `@ee/ingest/destination-path`, which uses the same functions as `ingestFile`: `expandSubfolder`,
  `plannedFileBase` and the name checks in `path-names.ts` (no Node imports, so the renderer can run
  them), with the app's template expander in `shared/ingest-template.ts`. Only the final join differs:
  ingest uses `path.join`, the preview writes the destination in the style it was typed (`E:\Photos`
  stays backslashes). The first ticked source supplies `{sourceName}`; the file is an example
  (`_DSC0001.NEF`) because a card's first file is not known before the copy, and the date is today's.
  A collision suffix is not predicted. A template ingest would refuse shows the reason instead.
- **Saving.** There is no Save button (`use-ingest-settings.ts`). An edit is written 500 ms after the last
  one; leaving the view writes a pending edit; a draft that is not valid (no folder, or Rename with no
  template) is never written and its field says why. A failed write stays on screen as `Not saved: …` and
  is tried again by the next edit or by Ingest. Settings that change elsewhere replace the form unless
  there is an edit of its own that has not been written.
- **Bar.** Left: what is ticked (`2 cards · 483 photos → /Photos/…`), or why nothing can start. Right:
  `Ingest`, or `Ingest 483 photos` once every ticked source has reported a count (only cards report one;
  a ticked folder or server keeps it at `Ingest`). Pressing it flushes the form first and starts with the
  saved values; if that write fails nothing starts. While any source runs the primary button is `Stop all`
  and, if ticked sources are not running, a plain `Ingest` button starts only those
  (`startIngest(settings, only)`).

## Screenshots

`pnpm screenshot [--out <dir>]` launches the built Electron app via Playwright
with mock data (`EE_MOCK=1`) and writes PNGs of the main views (Develop, crop, retouch, Library grid with
a multi-selection, loupe, Ingest, settings), then a real-mode run over the fixtures. Agents attach
them to PRs (see `AGENTS.md`).
