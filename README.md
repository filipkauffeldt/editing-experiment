# editing-experiment

## What it is

An AI-developed proof of concept: the code was written and reviewed by AI
agents, with direction and decisions from the repository owner. It is not
production software.

A desktop app for sports photographers and photojournalists: Photo Mechanic
style ingest, captioning and FTP/SFTP, Lightroom/Camera Raw style develop with
Lightroom preset import, and a minimal mosaic/pixelate retouch mode. Electron,
React and TypeScript with a Rust native core through napi-rs; licensed
GPL-3.0-or-later.

The proof of concept covers the workflow in "Proof of concept: scope and demo"
in `docs/ARCHITECTURE.md`: ingest with filters, Library, Develop, retouch and
Export / Export & send.

## Implemented

- Ingest from folder and card sources and from polled FTP/FTPS/SFTP servers, in
  parallel. Each source copies in filename order, with an explicit choice of
  keeping the original file names or renaming with a template (and an optional
  subfolder template), SHA-256 verification, an optional backup destination,
  and no writes to the originals; deleting from a server is opt-in and off by
  default. Keeping names adds a numeric suffix when two sources hold the same
  name, so nothing is overwritten.
- Per-source local ingest filters: file types RAW / JPEG / Both, lock state
  Locked / Unlocked / All, and incremental ingest (on by default).
- Photo Mechanic `.XMP` metadata templates with Replace (the default) or Fill
  empty, `=code=` replacement tables, and `{variables}` in captions and path
  templates. Templates and code replacement files live in Settings → Metadata
  and are shared by ingest, the Metadata panel and batch caption. A develop
  preset can be applied to every imported photo.
- IPTC metadata in XMP sidecars for raws and embedded IIM + XMP for JPEGs.
  Tagged state and colour class use Photo Mechanic's `Tagged` and `ColorClass`
  fields and the combined `Prefs` string; the class is mirrored to `xmp:Label`
  (with label syncing on, the default) and the rating is written to
  `xmp:Rating` and `Prefs`.
- Library: virtualised grid and loupe, multi-select (click, Shift range,
  Ctrl/⌘ toggle, Ctrl/⌘+A), quick and colour-class filters. Folders are derived
  from the local ingest copies only; cards and servers are intentionally not
  shown there.
- Batch caption for the selection: replace or append selected IPTC fields,
  with codes and `{variables}` expanded per photo.
- Star ratings `1`-`5` (`0` clears), colour classes `Ctrl/⌘`+`1`-`8`
  (`Ctrl/⌘`+`0` clears) and tag `T`, applied to the Library selection or the
  open photo.
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
- Retouch mosaic (rectangle, lasso) with YuNet face detection inside a
  rectangle or lasso. Every area and face can be switched on and off and
  subtracted again, and a saved retouch can be resumed and edited.
- Export presets (folder and file name templates, resize, output sharpening,
  metadata and send targets) and Export / Export & send / Next & send. By
  default a photo is exported to an `export` folder next to it, e.g.
  `/Photos/20261104_GAIS-AIK/export/`; `{photofolder}` in a preset's folder
  template is the photo's own folder; a template that does not start with it
  is absolute or relative to the export root. Export rendering targets the
  preset's output size and rejects an embedded preview of the unretouched
  image.
- Anonymous FTP for sources and destinations when no credentials are set.

## Known gaps

- Without Adobe's camera profiles, colour comes from LibRaw's camera matrix
  and a simple highlight shoulder, which is not Lightroom's rendering. With
  profiles the maths follows the DNG SDK, but the result has not been compared
  with a Lightroom export. Profiles with an RGB table (Artistic, Vintage,
  Modern looks), monochrome looks and three-illuminant profiles are not
  rendered; `DefaultBlackRender` and the camera's own baseline exposure are
  not applied.
- Texture, Clarity, Dehaze, sharpening and noise reduction follow RAWmakase's
  fits of Camera Raw, not Camera Raw itself. Raws start with Adobe Camera Raw's
  default sharpening and noise reduction (the camera's own `crd:` values are
  ignored, as Adobe Default does), shown on the sliders but never written to the
  sidecar.
- Nikon HE/HE* NEFs (TicoRAW) are not supported by the vendored LibRaw 0.22.3.
- Full-size exports (`resize: none`) send the rendered RGBA buffer over IPC
  (about 180 MB for a 45 MP frame). Smaller exports render at the preset's
  output size and avoid that copy; the full-size path is a known cost.
- GPU performance is unmeasured: the tests and screenshots use software GL
  (SwiftShader), so preview and export speed on a real GPU has not been
  benchmarked.
- macOS has not been run. Windows has a CI workflow (`.github/workflows/windows.yml`) but has not been
  used on a real machine with a card yet. On Windows the full unit suite, the WebGL parity tests and
  the other Electron e2e suites are not run in CI, and `pnpm dev` prints a Node deprecation warning
  (`DEP0190`) from the dev launcher.
- Photo Mechanic and Lightroom compatibility has not been verified against real
  reference files: sidecar labels and ratings, develop settings and profile
  renders are tested internally (and the profile maths against the DNG SDK),
  not against files produced by those apps.
- There is no installer or packaging; run the app from source.

## Getting started

Linux/Ubuntu 24.04 is the primary development platform. Windows is covered in its own
section below.

### System dependencies

These are for Linux. On Windows the list is the table under "Windows" below.

- Node 24 and pnpm. Install Node 24, then run `corepack enable` once; the pnpm
  version (12.15.0) is pinned by `packageManager` in `package.json`. Fedora's
  `nodejs` package does not include `corepack` and may be older than Node 24,
  so install Node 24 with fnm (or another Node 24 install) and enable Corepack
  from there.
- Rust stable via rustup (edition 2024); install it with
  `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`. If rustup
  reports that no default toolchain is configured, run `rustup default stable`.
  A C/C++ compiler (`g++` or `clang++`) is also needed. LibRaw is vendored in
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

Electron's npm package is installed without its binary, so `pnpm dev`,
`pnpm screenshot` and the Electron tests download it on first run; no separate
step is needed. If Electron fails to start with "Electron uninstall", run
`node scripts/ensure-electron.mjs` once.

On Ubuntu 24.04 and later, AppArmor restricts unprivileged user namespaces and
the SUID `chrome-sandbox` helper shipped in `node_modules` is not configured, so
Electron aborts at startup. `EE_NO_SANDBOX=1` passes `--no-sandbox` to the dev
launch. Only Ubuntu has this restriction; Fedora and other distributions do not
need the flag. The flag is only passed by the dev launcher; app code never
disables the sandbox. Do not chown or chmod the sandbox binary.

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
(`EE_SOFTWARE_GL=1`) so WebGL is available without a GPU; the develop-gl parity tests
run in headless Chromium with the same fallback.

CI (`.github/workflows/ci.yml`) runs lint/typecheck, Rust fmt/clippy/tests,
unit tests, the WebGL parity tests, the Electron e2e suites and the screenshot
build on Ubuntu. `.github/workflows/windows.yml` is a separate workflow on
`windows-latest`; see "Windows" below for the steps it runs.

If you touch `crates/`:

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

The raw tests use `fixtures/raw`; `EE_SAMPLE_NEF_DIR=~/nefs pnpm test` also runs
them against your own NEFs (read only). Tests skip cleanly when the fixtures or
the variable are absent.

### Windows

Windows 10 or 11, 64-bit. The Windows workflow runs on the `windows-2025-vs2026` runner image
(Windows Server 2025) and the steps below are the ones it runs.

Prerequisites, all installed for your user or machine; nothing else is needed (no Python, CMake,
LLVM or pkg-config, LibRaw is vendored and built by `cc`):

| Tool                                               | Version                                         | Get it                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual Studio Build Tools with the C++ build tools | MSVC 14.51 (Visual Studio 2026) on the CI image | "Build Tools for Visual Studio" from <https://visualstudio.microsoft.com/downloads/>; tick **Desktop development with C++**, which includes the Windows SDK |
| Rust, MSVC toolchain (not the GNU one)             | stable, 1.99.1 on the CI image; 1.85 or newer   | `winget install --id Rustlang.Rustup`, then `rustup default stable-x86_64-pc-windows-msvc`                                                                  |
| Node                                               | 24 (24.22.2 on the CI image)                    | The v24 installer from <https://nodejs.org/en/download>                                                                                                     |
| pnpm                                               | 12.15.0, pinned by `packageManager`             | `npm install --global pnpm@12.15.0` (or `corepack enable` from an administrator shell)                                                                      |
| Git for Windows                                    | any recent (2.56.0 on the CI image)             | `winget install --id Git.Git`                                                                                                                               |

Open a new PowerShell after installing, so the tools are on `PATH`. A normal PowerShell is enough:
the build finds the Visual Studio compiler by itself, no "Developer" prompt is needed.

```powershell
git clone https://github.com/filipkauffeldt/editing-experiment.git
cd editing-experiment
pnpm install --frozen-lockfile
pnpm build:native        # the Rust core: the first build compiles LibRaw and takes a few minutes
pnpm fetch-fixtures      # optional: CC0 Nikon NEFs for the raw tests
pnpm fetch-retouch       # optional: YuNet model and face photos for the face tests
pnpm dev
```

`pnpm dev` builds the native core again if needed, starts the Vite dev server and opens the app;
Electron downloads its binary on first run. To try the UI with generated photos:
`$env:EE_MOCK = '1'; pnpm dev`. `EE_NO_SANDBOX` is a Linux/Ubuntu flag and not needed here.

What the Windows workflow runs, in this order:

```powershell
pnpm install --frozen-lockfile
pnpm build:native
node scripts/fetch-fixtures.ts
cargo test --release
cargo clippy --release --all-targets -- -D warnings
pnpm fetch-retouch
pnpm test:unit:windows        # ingest, export, metadata, retouch, contracts, core and the jobs-backend tests
pnpm --filter "@ee/desktop" run build
pnpm test:e2e:launch          # starts the built app against a temporary EE_USER_DATA_DIR
pnpm test:e2e:crop            # the real-mode smoke test (ingests a NEF) and the crop overlay tests
pnpm dev                      # until it prints "starting electron app", then checks Electron is running
```

Not run on Windows: `pnpm lint` and `pnpm typecheck` (Linux CI covers the same files), the rest of
`pnpm test:unit` (React and renderer tests, which do not touch the operating system), the WebGL
parity tests (`pnpm test:browser`), and the other Electron e2e suites (`pnpm test:e2e:demo`,
`:export`, `:zoom`) and `pnpm screenshot`.

The repository is checked out with LF line endings (`.gitattributes`), whatever `core.autocrlf` is.

## First use

Set things up in this order:

1. **Settings → Metadata.** Add the Photo Mechanic metadata template `.XMP` files
   and tab-delimited code replacement files. This global list feeds the
   Metadata panel and ingest.
2. **Settings → Ingest.** Choose the destination folder and whether to
   **Keep original file names** or **Rename** with a template (and optionally a
   subfolder template and backup folder). Pick the metadata template from the
   global list and its mode, `Replace existing values` (the default) or
   `Fill empty fields`, and choose the develop preset to apply on import.
   Import presets with **Develop → Presets → Import** first.
3. **Insert a card.** Open the **Ingest** view: the inserted cards (volumes with a
   `DCIM` folder) are listed under **Cards** on their own, with the volume label,
   mount path and image count. No path to type. The cards are looked for when the
   view opens; insert or remove one afterwards and press **Rescan cards**
   (the circular arrow). Tick the cards to ingest; each ticked card has its own
   filters: file types RAW / JPEG / Both, lock state Locked / Unlocked / All, and
   Incremental (on by default). A card is never ingested just because it appeared.
   Linux (`/media`, `/run/media`), macOS (`/Volumes`) and Windows (drives D: to Z:)
   are scanned; only Linux has been run on a real machine so far. On Windows a card
   is named after its volume label (`NIKON Z 6`), or `Drive E` when it has none.
4. **Settings → Sources** is the fallback for what is not found on its own:
   a folder, a card with an unusual mount point, an FTP or SFTP server. **Test** and
   **Save source**; local sources have the same filters, and these sources are
   ingested every time. Anonymous FTP needs no password.
5. **Settings → Destinations** for upload targets, and **Export… → New
   preset** for export presets (Location, File, Content, Then send), then
   **Save preset** and **Set as active**. The default preset exports into an
   `export` folder next to each photo; the app leaves that folder alone when it
   ingests or looks for photos, and a missing or read-only photo folder fails
   that photo with a message naming the folder. A preset keeps the photo's current
   base name or renames with a file name template; keep mode only adds `-1`,
   `-2` when a file of that name already exists.
6. Optional: **Settings → Profiles → Add folder…** for `.dcp`/`.xmp` camera
   profiles. Adobe's own folders are found automatically on macOS and Windows.
   See [Camera profiles](docs/camera-profiles.md) for the platform details.
7. Start with **Ingest → Ingest**, then **Library** → **Develop** →
   **Export…** or **Export & send** (or **Next & send**, Ctrl/⌘+Enter).

## Keyboard shortcuts

`Ctrl/⌘` means Ctrl, or Cmd on macOS. Letters and digits match the character
the key prints, so the shortcuts are designed for a Swedish layout; AltGr combinations
are treated as text. `F1` opens the in-app list; `?` does too, as does
`Ctrl/⌘` plus the physical Slash key (except where that key prints `-`, as on a
Swedish keyboard: there `Ctrl/⌘` + `-` zooms out). In Ingest only `G` and `D` switch
modules.

| Key                            | Action                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `G` / `D` / `E`                | Library grid / Develop / Library loupe (with a photo selected)                                         |
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
| `Z`                            | Toggle Fit and the zoom level chosen in the footer (100% to start); in Develop, crop and retouch       |
| `Ctrl/⌘`+`+` / `-`             | Zoom in / out in steps (`=` and the numpad keys work too); `Ctrl/⌘`+`0` stays the colour class clear   |
| `Ctrl/⌘`+wheel or pinch        | Zoom around the pointer                                                                                |
| `Scroll`                       | Pan the zoomed photo in any mode (does nothing at Fit); `Shift`+scroll pans sideways                   |
| `Space`+drag                   | Pan the zoomed photo in any mode; the active tool is paused while Space is held                        |
| `Ctrl/⌘`+`Z`                   | Undo the last retouch shape                                                                            |
| `Ctrl/⌘`+`I`                   | Batch caption (Library); focus the caption field (Develop)                                             |
| `Ctrl/⌘`+`K`                   | Batch caption at Keywords (Library); focus the keywords field (Develop)                                |
| `Ctrl/⌘`+`A`                   | Select all in the Library                                                                              |
| `Shift`+`Ctrl/⌘`+`C`           | Copy settings…                                                                                         |
| `Shift`+`Ctrl/⌘`+`V`           | Paste settings to the selection                                                                        |
| `Ctrl/⌘`+`Alt`+`V`             | Paste the previous photo's settings                                                                    |
| `Shift`+`Ctrl/⌘`+`E`           | Export…                                                                                                |
| `Shift`+`Ctrl/⌘`+`Enter`       | Export & send                                                                                          |
| `Ctrl/⌘`+`Enter`               | Next & send (Develop)                                                                                  |
| `?` / `F1`                     | Show the in-app shortcut list (`Ctrl/⌘`+`/` where that key does not print `-`)                         |

## Credentials

Passwords and SFTP key material are stored only through Electron `safeStorage`,
encrypted, in `userData/credentials.json`. Without an OS keyring (Secret
Service, e.g. `gnome-keyring`, or KWallet) the app refuses to store them and
says so; there is no plaintext fallback. Anonymous FTP needs no keyring, and
folder sources and destinations do not need one.

## Repository layout

- `apps/desktop` — Electron app: main, preload, jobs utility process, React renderer.
- `crates/core` — napi-rs addon: vendored LibRaw, previews, raw decode, JPEG decode/resize/encode, Windows drive labels.
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
