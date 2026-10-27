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
- **Rust stable** via rustup (edition 2024), plus a C/C++ toolchain (`gcc`, `g++`; `clang`/`cmake`/`pkg-config` for the LibRaw build later).
- **Electron runtime libraries.** On Debian/Ubuntu: `sudo apt install libgtk-3-0t64 libpango-1.0-0` (older releases call the first package `libgtk-3-0`).
- **Xvfb** for headless runs on a machine without a display (`pnpm screenshot`, Playwright e2e): `sudo apt install xvfb xauth`. `pnpm screenshot` re-runs itself under `xvfb-run` when `DISPLAY` is unset.

### Running Electron on Ubuntu 24.04: `EE_NO_SANDBOX`

Ubuntu 24.04 restricts unprivileged user namespaces with AppArmor, and the SUID
`chrome-sandbox` helper that Electron ships is not set up in a `node_modules`
install, so Electron aborts at startup with a sandbox error. For **development and
tests only**, set `EE_NO_SANDBOX=1` to start Electron with `--no-sandbox`:

```sh
EE_NO_SANDBOX=1 pnpm dev
```

`pnpm screenshot` and e2e tests set it themselves. The main process honours the
variable only when `app.isPackaged` is false, so packaged builds always run sandboxed.
Do not `chown`/`chmod` the sandbox binary.

### Mock mode

`EE_MOCK=1` makes the jobs process serve generated placeholder photos over the normal
IPC API (and `app://thumb|preview/<id>` serve generated images). Screenshots use it.
