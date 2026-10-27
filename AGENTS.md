# Agent instructions

Read this file fully before starting. Then read `docs/ARCHITECTURE.md`.

## What this is

A lightweight desktop app for sports photographers and photojournalists:
Photo Mechanic style ingest, captioning and FTP, Lightroom/Camera Raw style
basic develop (preset compatible), and a minimal retouch mode (mosaic/pixelate
faces). Electron + React + TypeScript, with a Rust native core (napi-rs).
Licensed GPL-3.0-or-later.

Current goal: a working **proof of concept** (see "PoC demo" in
`docs/ARCHITECTURE.md`). Prefer simple, working, tested code over generality.

## Toolchain

- Node 24, pnpm (workspaces), TypeScript strict, ESM everywhere.
- Rust stable (edition 2024) in `crates/`, exposed to Node via napi-rs.
- Tests: vitest for TS, `cargo test` for Rust, Playwright (Electron) for e2e
  and screenshots.
- Run before pushing: `pnpm lint && pnpm typecheck && pnpm test`
  (and `cargo test` / `cargo clippy -- -D warnings` if you touched `crates/`).

No sudo is available. Do not add dependencies that need system packages;
vendor/compile C/C++ sources via the `cc` crate instead (no bindgen; hand-write
the small FFI surface).

If something genuinely needs a system install, **stop immediately** and end
your turn with a line starting with `NEEDS INSTALL:` and the exact command
(e.g. `sudo apt install xvfb`). Do not work around it or continue with other
work; you will be told to continue once it is installed. Keep the "System dependencies"
section of `README.md` up to date.

## Ownership and contracts

Each workstream owns specific directories (listed in its task). Do not edit
files outside your directories except:
- adding your package to workspace config / CI if needed,
- `packages/contracts`: only if your task says so. If you think the contract
  is wrong, say so in the PR description under "Contract concerns" and work
  around it locally instead of changing it.

Code against the types in `packages/contracts`, never against another
workstream's internals.

## Platform

Linux is the dev platform, but code must stay macOS/Windows compatible:
- use `node:path`, never hard-code `/` separators or Linux-only paths,
- no shelling out to Linux-only tools,
- platform-specific code (e.g. card detection) behind an interface with a
  Linux implementation and a clear TODO for the others.

## Safety rules (hard)

- Never modify or delete original files on a source (card, folder, remote
  server). Ingest copies; it never moves. Remote deletion only behind an
  explicit per-source option that defaults to off.
- Raw files are never written to. Metadata for raws goes to XMP sidecars.
- Exported JPEGs must not contain any embedded thumbnail/preview of the
  unretouched image.
- Credentials are never logged, never committed, and stored only via
  Electron `safeStorage`.
- Only GPL-3.0-compatible dependencies (MIT, BSD, Apache-2.0, ISC, LGPL,
  MPL-2.0, GPL). No non-commercial or proprietary model weights or SDKs.
- Do not commit raw files or other large binaries. Test fixtures are fetched by
  `scripts/fetch-fixtures` (CC0 samples from raw.pixls.us) or generated in
  tests. Local NEFs can be pointed to with `EE_SAMPLE_NEF_DIR` (optional, tests
  must skip cleanly when unset).

## Git workflow

- Branch: `feature/<short-name>`, `fix/<short-name>` or `chore/<short-name>`.
  No issue numbers.
- **Small, logical commits.** Each commit builds and has a clear message in
  imperative mood (`Add code replacement parser`, not `wip` or `updates`).
  Separate refactors from behaviour changes. No giant "implement everything"
  commit.
- Open a PR against `main` with `gh pr create`. The PR body contains: summary,
  what was tested and how, known limitations, "Contract concerns" if any.
- UI changes: include screenshots where reasonable. Capture with
  `pnpm screenshot` (Playwright + Electron, see `docs/ARCHITECTURE.md`) and
  upload with `gh pr edit <n> --attach '/abs/path.png#Alt text'`
  (run inside the repo, absolute paths). Never commit screenshots.
- When you receive review feedback, address it in new commits on the same
  branch (no force-push unless rebasing onto `main` is requested), push,
  and reply with a short summary of what changed.
- Do not merge your own PR.

## Code style

- Match surrounding code. Small modules, explicit types at module boundaries,
  no `any`.
- Errors: throw typed errors or return results; never swallow errors silently.
- Tests prove behaviour (inputs → outputs, files on disk, bytes on the wire),
  not mock wiring. Use real temp dirs, in-process FTP/SFTP servers, real
  ExifTool.
- Comments explain why, not what.
