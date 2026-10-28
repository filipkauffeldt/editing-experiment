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
  templates, hash verification, an optional backup destination, and no writes
  to the originals.
- Photo Mechanic `.XMP` metadata templates, `=code=` replacement tables, and
  `{variables}` in captions and path templates.
- IPTC metadata in XMP sidecars for raws and embedded IIM + XMP for JPEGs.
  Tagged/colour class is mirrored to `xmp:Label`.
- WebGL2 develop preview and full-resolution rendering with Lightroom-compatible
  `crs:` parameters (exposure, temperature/tint, contrast, highlights, shadows,
  whites, blacks, tone curves, vibrance, saturation) and imported `.xmp`
  presets. Legacy `.lrtemplate` presets are parsed too.
- Retouch mosaic, with YuNet face detection inside a dragged region.
- **Finish & next**: full-resolution JPEG with the selected metadata and no
  embedded preview of the unretouched image, then a folder/FTP/FTPS/SFTP upload
  queue.
- Anonymous FTP for sources and destinations when no credential reference is
  set.

## Known gaps

- Colour is not calibrated against Lightroom: camera matrices come from LibRaw
  and there are no Adobe DCP profiles, so develop results will not match
  Lightroom exactly.
- Nikon HE/HE* NEFs (TicoRAW) are not supported by the vendored LibRaw 0.22.3.
- Crop and straighten round-trip through `crs:` sidecars but are not applied in
  the preview or export yet; that work is in progress.
- Full-resolution export sends the rendered RGBA buffer over IPC (about 180 MB
  for a 45 MP frame). It works, but the copy is a known cost.
- macOS and Windows are untested; CI runs on Linux only.
- Photo Mechanic label compatibility (`Tagged`/`ColorClass` ↔ `xmp:Label`) is
  implemented but has not been verified against a real Photo Mechanic install.

## Getting started

Linux/Ubuntu 24.04 is the primary development platform.

### System dependencies

- Node 24 and pnpm. The pnpm version (12.15.0) is pinned by `packageManager` in
  `package.json`; `corepack enable` uses it.
- Rust stable via rustup (edition 2024) and a C/C++ compiler (`g++` or
  `clang++`). LibRaw is vendored in `crates/core/vendor/libraw` and compiled by
  `build.rs`; no system LibRaw, cmake or pkg-config is needed.
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
This is for development and tests only; packaged builds always run sandboxed.
Do not chown or chmod the sandbox binary.

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

If you touch `crates/`:

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

The raw tests use `fixtures/raw`; `EE_SAMPLE_NEF_DIR=~/nefs pnpm test` also runs
them against your own NEFs (read only). Tests skip cleanly when the fixtures or
the variable are absent.

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

See `docs/ARCHITECTURE.md` for the design.
