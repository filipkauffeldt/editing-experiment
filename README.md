# editing-experiment

Lightweight ingest, captioning, develop and FTP app for sports photographers and
photojournalists. Electron + React + Rust. Work in progress (proof of concept).

See `docs/ARCHITECTURE.md` and `AGENTS.md`. Licensed GPL-3.0-or-later.

## Getting started

```sh
pnpm install
pnpm build:native        # compiles crates/core (needs Rust); `pnpm test` does it for you
pnpm dev                 # Electron app with hot reload (EE_MOCK=1 pnpm dev for generated photos)
pnpm lint && pnpm typecheck && pnpm test
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm screenshot          # builds, launches the app with mock data, writes screenshots/*.png
pnpm fetch-fixtures      # CC0 Nikon NEF samples into fixtures/raw/ (gitignored)
pnpm fetch-retouch       # YuNet model + public-domain face photos into fixtures/ (gitignored)
EE_SAMPLE_NEF_DIR=~/nefs pnpm test   # optionally also run the raw tests on your own NEFs
```

| Path                 | What                                                          |
| -------------------- | ------------------------------------------------------------- |
| `apps/desktop`       | Electron app: `main`, `preload`, `jobs` (utility), `renderer` |
| `crates/core`        | Rust napi-rs addon and its Node loader (`@ee/core`)           |
| `packages/contracts` | Shared types and the typed IPC map (`IpcApi`)                 |
| `packages/*`         | metadata, ingest, export, develop-gl, retouch                 |

## System dependencies

Needed on the development machine (the repo itself never installs system packages):

- **Node 24** and **pnpm** (the version is pinned by `packageManager` in `package.json`).
- **Rust stable** via rustup (edition 2024), plus a C/C++ compiler (`gcc`/`g++` or `clang`; MSVC on Windows). LibRaw is vendored in `crates/core/vendor/libraw` and compiled by `build.rs`, so no LibRaw, cmake or pkg-config install is needed.
- **Electron runtime libraries.** On Debian/Ubuntu: `sudo apt install libgtk-3-0t64 libpango-1.0-0` (older releases call the first package `libgtk-3-0`).
- **Chromium for Playwright** (WebGL parity tests of `packages/develop-gl` run in headless Chromium with software GL, no GPU needed): `pnpm --filter @ee/develop-gl exec playwright install chromium` (add `--with-deps` on a fresh Linux box; that part needs sudo).
- **An OS keyring** (GNOME Keyring or KWallet on Linux) to store FTP/SFTP passwords. The app encrypts them with Electron `safeStorage` and refuses to store them when no keyring is available; there is no plaintext fallback. Folder sources and destinations work without one.
- **Xvfb** for headless runs on a machine without a display (`pnpm screenshot`, Playwright e2e): `sudo apt install xvfb xauth`. `pnpm screenshot` re-runs itself under `xvfb-run` when `DISPLAY` is unset, and the Electron smoke test (`apps/desktop/test/real-mode.smoke.test.ts`) starts `Xvfb` itself when there is no display.

### Running Electron on Ubuntu 24.04: `--no-sandbox` (dev and tests only)

Ubuntu 24.04 restricts unprivileged user namespaces with AppArmor, and the SUID
`chrome-sandbox` helper that Electron ships is not set up in a `node_modules`
install, so Electron aborts at startup with "The SUID sandbox helper binary was found,
but is not configured correctly". For **development and tests only**, start Electron
with `--no-sandbox`:

```sh
EE_NO_SANDBOX=1 pnpm dev     # apps/desktop/scripts/dev.ts passes --no-sandbox to Electron
```

`pnpm screenshot` and Playwright e2e launch through Playwright's `_electron`, which
already passes `--no-sandbox`. The flag is a launch argument and is never baked into
the app, so packaged builds always run sandboxed. Do not `chown`/`chmod` the sandbox binary.

### Mock mode

`EE_MOCK=1` makes the jobs process serve generated placeholder photos over the normal
IPC API (and `app://thumb|preview/<id>` serve generated images). Screenshots use it.
