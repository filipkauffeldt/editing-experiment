# editing-experiment

## What it is

A desktop app for sports photographers and photojournalists: Photo Mechanic
style ingest, captioning and FTP, Lightroom/Camera Raw style basic develop with
preset compatibility, and a minimal mosaic/pixelate retouch mode. Electron,
React and TypeScript with a Rust native core through napi-rs; licensed
GPL-3.0-or-later.

It is a proof of concept, not production software. The PoC demo in
`docs/ARCHITECTURE.md` is the current definition of done.

## What works today

- Ingest from folder and card sources and from polled FTP/FTPS/SFTP servers, in
  parallel. Each source copies in filename order, with rename and subfolder
  templates, SHA-256 verification, an optional backup destination, and no
  writes to the originals; deleting from a server is opt-in and off by
  default.
- Photo Mechanic `.XMP` metadata templates with Replace (the default) or Fill
  empty, `=code=` replacement tables, and `{variables}` in captions and path
  templates. Ingest can apply a develop preset to every imported photo.
- IPTC metadata in XMP sidecars for raws and embedded IIM + XMP for JPEGs.
  Tagged state and colour class use Photo Mechanic's `Tagged` and `ColorClass`
  fields and the combined `Prefs` string; the class is mirrored to `xmp:Label`
  (with label syncing on, the default) and the rating is written to
  `xmp:Rating` and `Prefs`.
- Library: virtualised grid and loupe, multi-select (click, Shift range,
  Ctrl/⌘ toggle, Ctrl/⌘+A), quick and colour-class filters. Folders are the
  local ingest copies only, so cards and servers never appear there.
- Batch caption for the selection: replace or append selected IPTC fields,
  with codes and `{variables}` expanded per photo.
- Star ratings `1`-`5` (`0` clears), colour classes Ctrl+`1`-`8` (Cmd on macOS;
  `0` clears) and tag `T`. They apply to the Library selection or the open
  photo.
- Edited thumbnails and previews: develop settings, crop/straighten and the
  newest mosaic are drawn into the film strip and previews, not just the
  camera's embedded preview.
- Develop panel with WebGL2 preview and export rendering: Basic (White
  balance, Tone), Presence, Tone Curve (parametric, point RGB and R/G/B),
  Color Mixer, Color Grading wheels, Detail (sharpening and noise reduction),
  Lens Corrections (Nikon's embedded data or Lensfun, manual
  distortion/vignette, Remove chromatic aberration and Defringe), Effects
  (post-crop vignette and grain), Calibration, camera profiles and imported
  `.xmp` presets.
- Histogram read from the rendered frame, clipping `J`, before/after `Y`,
  white balance picker `W`, Auto tone and Auto WB.
- Lightroom-style crop and straighten `C`, applied in the preview and the
  export.
- Copy, paste and sync develop settings by group.
- Retouch mosaic (rectangle, lasso, magic wand) with YuNet face detection
  inside a dragged region.
- Export presets (JPEG location, resize, output sharpening, metadata and send
  targets) and Export / Export & send / Next & send. Exports render at the
  preset's output size and contain no embedded preview of the unretouched
  image.
- Anonymous FTP for sources and destinations when no credentials are set.

## Camera profiles

Lightroom renders a raw through a _profile_. Adobe's profiles are Adobe's files, so this app
does not ship them: you point it at your own copies and it reads them where they are (nothing
is copied into the app or the repository).

- **macOS and Windows.** Install the free [Adobe DNG
  Converter](https://helpx.adobe.com/camera-raw/using/adobe-dng-converter.html) (Lightroom
  Classic and Photoshop's Camera Raw install the same files). The profiles are in
  `/Library/Application Support/Adobe/CameraRaw/CameraProfiles` (macOS) and
  `C:\ProgramData\Adobe\CameraRaw\CameraProfiles` (Windows); the app searches those folders and
  the per-user `CameraProfiles` folder (`~/Library/Application Support/Adobe/CameraRaw/CameraProfiles`,
  `%APPDATA%\Adobe\CameraRaw\CameraProfiles`) by itself. Adobe Standard and the Camera Matching
  profiles are `.dcp` files in subfolders there.
- **Linux.** Adobe has no Linux installer. Copy the `CameraProfiles` folder from a Mac or
  Windows machine, then add it in _Settings → Profiles → Add folder…_ (or from _Browse profile
  folders…_ under Profile in the Develop panel). Folders are scanned recursively for `.dcp`
  and `.xmp` files.
- XMP profiles such as Adobe Color, Landscape, Portrait, Vivid and Neutral are `.xmp` files with
  an HSV table. They are found in any folder you add; if Adobe's installer puts them
  elsewhere on your machine, add that folder too.

The Profile select at the top of the Develop panel offers the profiles made for the photo's
camera, grouped Adobe Raw / Camera Matching / Other. The choice is written to the sidecar as
`crs:CameraProfile` (and `crs:Look` for an XMP profile), so Lightroom reads it too. A photo
whose sidecar names a profile this machine does not have keeps the name, says so in the
panel and is drawn with the camera matrix. For a development test against real profiles, set
`EE_PROFILE_DIR` to the profile folder and `EE_SAMPLE_NEF_DIR` to a folder of NEFs.

## Known gaps

- Colour matches Lightroom only when you give the app Adobe's camera profiles (see
  "Camera profiles" below). Without one, colour comes from LibRaw's camera matrix and a
  simple highlight shoulder, which is not Lightroom's rendering. Profiles with an RGB
  table (Artistic, Vintage, Modern looks), monochrome looks and three-illuminant
  profiles are not rendered; `DefaultBlackRender` and the camera's own baseline
  exposure are not applied.
- Texture, Clarity, Dehaze, sharpening and noise reduction follow RAWmakase's
  fits of Camera Raw, not Camera Raw itself. Raws start with Lightroom's
  sharpening and colour noise reduction (or the camera's own `crd:` values), shown
  on the sliders but never written to the sidecar.
- Nikon HE/HE* NEFs (TicoRAW) are not supported by the vendored LibRaw 0.22.3.
- Full-size exports (`resize: none`) send the rendered RGBA buffer over IPC
  (about 180 MB for a 45 MP frame). Smaller exports render at the preset's
  output size and avoid that copy; the full-size path is a known cost.
- GPU performance is unmeasured: the tests and screenshots use software GL
  (SwiftShader), so preview and export speed on a real GPU has not been
  benchmarked.
- macOS and Windows are untested; CI runs on Linux only.
- Photo Mechanic and Lightroom compatibility has not been verified against real
  reference files: sidecar labels and ratings, develop settings and profile
  renders are tested internally (and the profile maths against the DNG SDK),
  not against files produced by those apps.
- There is no installer or packaging; run the app from source.

## Getting started

Linux/Ubuntu 24.04 is the primary development platform.

### System dependencies

- Node 24 and pnpm. Install Node 24, then run `corepack enable` once; the pnpm
  version (12.15.0) is pinned by `packageManager` in `package.json`.
- Rust stable via rustup (edition 2024); install it with
  `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`. A C/C++
  compiler (`g++` or `clang++`) is also needed. LibRaw is vendored in
  `crates/core/vendor/libraw` and compiled by `build.rs`; no system LibRaw,
  cmake or pkg-config is needed.
- Electron runtime libraries. On Debian/Ubuntu:
  `sudo apt install libgtk-3-0t64 libpango-1.0-0` (older releases call the first
  package `libgtk-3-0`).
- Chromium for Playwright's WebGL parity tests:
  `pnpm --filter @ee/develop-gl exec playwright install --with-deps chromium`
  (the `--with-deps` part needs sudo).
- Xvfb and xauth for headless Electron runs: `sudo apt install xvfb xauth`.
- An OS keyring (Secret Service, e.g. GNOME Keyring, or KWallet) if you want to
  store FTP/SFTP credentials. See "Credentials" below.

### Install and run

```sh
corepack enable
pnpm install
pnpm fetch-fixtures      # CC0 Nikon NEFs into fixtures/raw/ (gitignored)
pnpm fetch-retouch       # YuNet model and face photos into fixtures/ (gitignored)

EE_NO_SANDBOX=1 pnpm dev
```

On Ubuntu 24.04, AppArmor restricts unprivileged user namespaces and the SUID
`chrome-sandbox` helper shipped in `node_modules` is not configured, so Electron
aborts at startup. `EE_NO_SANDBOX=1` passes `--no-sandbox` to the dev launch.
The flag is only passed by the dev launcher; app code never disables the
sandbox. Do not chown or chmod the sandbox binary.

`pnpm dev` opens an Electron window and needs a graphical desktop session; it
will not start on a headless machine. Use `xvfb-run` for the tests and
screenshots there.

`EE_MOCK=1 pnpm dev` serves generated placeholder photos over the normal IPC
API, so you can exercise the UI without a camera, disk or server.

### Tests and screenshots

```sh
pnpm lint && pnpm typecheck
xvfb-run -a --server-args='-screen 0 1920x1080x24' pnpm test
pnpm screenshot          # builds, then writes screenshots/*.png
```

`pnpm test` builds the native addon and runs the vitest suites, including the
PoC end-to-end demo and the real-mode smoke test that drive Electron. Without a
`DISPLAY` those tests start Xvfb themselves, but `Xvfb` and `xauth` must be
installed. `pnpm screenshot` re-runs itself under `xvfb-run` when `DISPLAY` is
unset. The PoC e2e test and `pnpm screenshot` enable SwiftShader
(`EE_SOFTWARE_GL=1`) so WebGL works without a GPU; the develop-gl parity tests
run in headless Chromium with the same fallback.

CI (`.github/workflows/ci.yml`) runs lint/typecheck, Rust fmt/clippy/tests,
unit tests, the WebGL parity tests, the Electron e2e suites and the screenshot
build on Ubuntu.

If you touch `crates/`:

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

The raw tests use `fixtures/raw`; `EE_SAMPLE_NEF_DIR=~/nefs pnpm test` also runs
them against your own NEFs (read only). Tests skip cleanly when the fixtures or
the variable are absent.

## First use

Set things up in this order:

1. **Settings → Ingest.** Choose the destination folder and rename template
   (and optionally a subfolder template and backup folder). Pick the metadata
   template `.XMP` and its mode, `Replace existing values` (the default) or
   `Fill empty fields`, add code replacement files, and choose the develop
   preset to apply on import. Import presets with **Develop → Presets →
   Import** first.
2. **Settings → Sources.** Add a folder, card, FTP or SFTP source, then
   **Test** and **Save source**. Anonymous FTP needs no password.
3. **Settings → Destinations** for upload targets, and **Export… → New
   preset** for export presets (Location, File, Content, Then send), then
   **Save preset** and **Set as active**.
4. Optional: **Settings → Profiles → Add folder…** for `.dcp`/`.xmp` camera
   profiles. Adobe's own folders are found automatically on macOS and Windows.
5. Start with **Ingest → Ingest**, then **Library** → **Develop** →
   **Export…** or **Export & send** (or **Next & send**, Ctrl/⌘+Enter).

## Keyboard shortcuts

`Ctrl/⌘` means Ctrl, or Cmd on macOS. Letters and digits match the character
the key prints, so the shortcuts work on a Swedish layout; AltGr combinations
are treated as text. `F1` always opens the in-app list; `?` does too, as does
`Ctrl/⌘` plus the physical Slash key. In Ingest only `G` and `D` switch
modules.

| Key                            | Action                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `G` / `D` / `E`                | Library grid / Develop / Library loupe                                                                 |
| `←` `→`                        | Previous / next photo; Shift extends the selection                                                     |
| `↑` `↓`                        | Previous / next grid row in the Library; Shift extends                                                 |
| `T`                            | Tag / untag                                                                                            |
| `1`-`5`, `0`                   | Star rating; `0` clears                                                                                |
| `Ctrl/⌘`+`1`-`8`, `Ctrl/⌘`+`0` | Colour class; `Ctrl/⌘`+`0` clears                                                                      |
| `C`                            | Enter crop mode / apply the crop                                                                       |
| `Enter`                        | Apply the crop (crop mode)                                                                             |
| `R`                            | Retouch; in crop mode, the crop frame tool                                                             |
| `A` / `O` / `X`                | Straighten tool / cycle overlay / swap orientation (crop mode)                                         |
| `Ctrl/⌘`+`Alt`+`R`             | Reset the crop                                                                                         |
| `Esc`                          | Cancel crop, WB picker or retouch; close the shortcut list; leave a field; clear the Library selection |
| `Y` or the physical `\` key    | Before / after (Develop)                                                                               |
| `J` / `W`                      | Clipping overlay / white balance picker (Develop)                                                      |
| `Ctrl/⌘`+`Z`                   | Undo the last retouch shape                                                                            |
| `Ctrl/⌘`+`I`                   | Batch caption (Library); focus the caption field (Develop)                                             |
| `Ctrl/⌘`+`A`                   | Select all in the Library                                                                              |
| `Shift`+`Ctrl/⌘`+`C`           | Copy settings…                                                                                         |
| `Shift`+`Ctrl/⌘`+`V`           | Paste settings to the selection                                                                        |
| `Ctrl/⌘`+`Alt`+`V`             | Paste the previous photo's settings                                                                    |
| `Shift`+`Ctrl/⌘`+`E`           | Export…                                                                                                |
| `Shift`+`Ctrl/⌘`+`Enter`       | Export & send                                                                                          |
| `Ctrl/⌘`+`Enter`               | Next & send (Develop)                                                                                  |
| `?` / `F1` / `Ctrl/⌘`+`/`      | Show the in-app shortcut list                                                                          |

## Credentials

Passwords and SFTP key material are stored only through Electron `safeStorage`,
encrypted, in `userData/credentials.json`. Without an OS keyring (Secret
Service, e.g. `gnome-keyring`, or KWallet) the app refuses to store them and
says so; there is no plaintext fallback. Anonymous FTP needs no keyring, and
folder sources and destinations work without one.

## Repository layout

- `apps/desktop` — Electron app: main, preload, jobs utility process, React renderer.
- `crates/core` — napi-rs addon: vendored LibRaw, previews, raw decode, JPEG decode/resize/encode.
- `packages/contracts` — shared types and the typed IPC map.
- `packages/metadata` — ExifTool service, Photo Mechanic templates, code replacements, variables, sidecars.
- `packages/ingest` — folder/card and polled FTP/SFTP sources, copy, rename, verify.
- `packages/develop-gl` — WebGL2 develop pipeline, `crs:` model, Lightroom preset parser.
- `packages/retouch` — selections, mosaic, YuNet face detection.
- `packages/export` — JPEG encode, embedded-preview checks, upload queue.
- `scripts` — fixture fetchers and the screenshot runner.

## Licence

GPL-3.0-or-later; see `LICENSE`.

- Vendored LibRaw is dual LGPL-2.1/CDDL-1.0 (used under LGPL-2.1) — see
  `crates/core/vendor/libraw/LICENSE.LGPL` and `LICENSE.CDDL`.
- The YuNet face detection model is MIT (Shiqi Yu) — see
  `packages/retouch/third_party/yunet/LICENSE`.
- The embedded sRGB ICC profile is CC0 — see
  `crates/core/assets/sRGB-v2-magic.LICENSE.txt`.
- Colour and effects maths in `packages/develop-gl/src/color`, and the Texture,
  Clarity, Dehaze, sharpening and noise reduction maths (with its Camera Raw fit
  tables) in `packages/develop-gl/src/neighbourhood`, are ported from RAWmakase
  (https://github.com/pch/rawmakase, MIT, © 2026 RAWmakase contributors) — see
  `packages/develop-gl/third_party/rawmakase/LICENSE`.
- `packages/develop-gl/data/lensfun.json` is a pruned JSON conversion of the Lensfun lens
  database (https://lensfun.github.io/, CC BY-SA 3.0, © Lensfun contributors; the Nikon Z
  and Nikon F lenses only, regenerated with `pnpm update-lensfun`). It is data kept in its
  own file under its own licence — see `packages/develop-gl/data/LICENSE-lensfun-CC-BY-SA-3.0.txt`.
  The Lensfun library is not used; the lens model maths is written from its documentation.
- The camera profile pipeline (`packages/develop-gl/src/profile`) follows the Adobe DNG SDK
  (`dng_color_spec`, `dng_hue_sat_map`, `dng_render`, `dng_temperature`; © Adobe Inc., DNG SDK
  License Agreement, kept in `packages/develop-gl/third_party/adobe-dng-sdk/LICENSE`) and
  RAWmakase's profile support. The Robertson temperature table and the default (ACR 3) tone curve
  samples are the SDK's published data. No Adobe profile is included.
- NOTICE: RAWmakase is the reference implementation of those controls; its
  licence text is kept unchanged next to this repository's code.

See `docs/ARCHITECTURE.md` for the design.
