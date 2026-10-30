# Design

Cleaner, sharper and more monochrome: a professional tool in the spirit of Lightroom
Classic, Capture One and Photo Mechanic, not a web app. Everything below is implemented
as CSS custom properties in one file, `apps/desktop/src/renderer/tokens.css`. Components
use the tokens and never hard-code a colour, size or font.

## Palette

| Token                      | Value     | Use                                         |
| -------------------------- | --------- | ------------------------------------------- |
| `--bg`                     | `#0e0e0f` | window, photo stage, grid                   |
| `--panel`                  | `#141415` | side panels, bars, dialogs                  |
| `--raised`                 | `#1c1c1e` | hovered and selected rows, toasts           |
| `--line`                   | `#232325` | hairline                                    |
| `--line-strong`            | `#2e2e31` | stronger hairline, field and button borders |
| `--text`                   | `#e8e8e8` | text, and the **only accent**               |
| `--muted`                  | `#8e8e90` | secondary text                              |
| `--dim`                    | `#58585b` | labels, disabled, hints                     |
| `--ok` / `--error`         | `#7dbb7d` / `#d26a6a` | status dots only                |

The accent is the text white: the active tab underline, the selection outline, the filled
tag square, the slider thumb and fill, and the primary button (white background, near-black
text). There are no blue accents, no coloured buttons and no coloured badges.

Colour appears only in:

- the photo,
- colour-class dots (6-7 px circles, `--class-1..8`),
- the temperature and tint slider tracks (desaturated gradients, `--track-temperature`,
  `--track-tint`),
- tiny status dots (`--ok`, `--error`): the top bar, toast status, a failed upload.

## Shape

Radius 0 everywhere except the circular dots and the colour wheels (`* { border-radius: 0 }`
in `global.css`). 1 px hairlines separate regions instead of boxes or cards. No drop shadows
on chrome; dialogs and popovers are a hairline border on `--panel`.

## Type

- Inter (variable), bundled from `@fontsource-variable/inter`, with a system fallback.
  12 px base, 11-11.5 px for secondary text.
- Section labels are 10 px uppercase, `0.1em` tracking, `--dim` (`--fs-label`,
  `--tracking-label`).
- Numbers are JetBrains Mono (variable, bundled from `@fontsource-variable/jetbrains-mono`)
  at 11 px with tabular figures: file names, slider values, counts and key hints (class `mono`
  or `--font-mono`).

Both fonts are SIL OFL 1.1, which is compatible with the project's GPL-3.0-or-later. Only the
Latin and Latin Extended subsets are bundled (`fonts.css`).

## Controls

Built in `components/ui/`:

- **Slider**: a 1 px track, a centre tick at neutral, a 2 x 11 px white bar thumb (no round
  knob), a 1 px white fill from neutral to the value, the value right-aligned in mono and
  typeable. Double-click resets. Temperature and tint tracks carry the desaturated gradients
  (3 px so the colour reads).
- **PanelSection**: title on the left (10 px label), then a small square on/off switch (a 1 px
  outlined 13 px square with a filled 5 px square). Collapsible; the caret is a rotated
  border. In Develop the switch parks a section's slider values and resets them to neutral, so
  the render drops the section; switching on restores them. The parked values are in memory
  only.
- **Field**: `underline` variant (a bottom hairline, no box) in side panels, `boxed` variant
  (a hairline box) in dialogs.
- **Button**: hairline outline; the `primary` variant is white with near-black text and is the
  one emphasised action in a bar or dialog.
- **Dot**: 6-7 px status and colour-class dots.
- Tabs and modes are text with a 1 px underline for the active one.
- **Selection** in the grid and film strip: a 2 px white outline with a 2 px offset.
- **Tag**: an 11 px square, filled white when tagged.
- **Status overlays** on thumbnails: tiny mono text labels on `#000a` (`sent`,
  `sending 64%`, `queued`, `failed`, `edited`, `retouched`, `meta ≠`).

## Layout

- **Top bar** (36 px): app mark, module switch (**Ingest · Library · Develop · Retouch**) and
  right-aligned status dots (ingesting, FTP watching, sending N, failed N), then shortcuts and
  settings.
- **Bottom action bar** (40 px): contextual actions on the right, summary and keyboard hints on
  the left.

### Modules

| Module  | Key | What it is                                                                         |
| ------- | --- | ---------------------------------------------------------------------------------- |
| Ingest  |     | sources with progress, ingest settings                                             |
| Library | `G` | folders and collections, virtualised grid, inspector; `E` opens the loupe          |
| Develop | `D` | metadata, photo, develop sliders, film strip                                       |
| Retouch |     | the retouch session on the Develop layout (`R`, or the tab); leaving it saves first |

The Library's **Folders** are the local ingest copies only. They are derived from each photo's
own path (always its copy in the ingest destination), never from the configured sources, so a
card or a remote server can not appear there. Ingest always copies; editing only ever happens
on the copies. The sidebar also has an **Ingesting → folder** section with per-source progress
and the Collections Tagged, Sent and Edited.

Library keys: click, Shift-range, Ctrl/Cmd-toggle, Ctrl/Cmd+A, arrows (Shift extends), `T` tag,
`1`-`5` rating (`0` clears), Ctrl/Cmd+`1`-`8` class (Ctrl/Cmd+`0` clears), Ctrl/Cmd+I caption, Shift+Ctrl/Cmd+C copy settings, Shift+Ctrl/Cmd+V paste
settings, Shift+Ctrl/Cmd+E export, Shift+Ctrl/Cmd+Enter export and send. The bottom bar's
**Sync…** opens the same group dialog for the whole selection. In Develop Ctrl/Cmd+Enter is Next & send, and its bar shows the active export preset
("Desk 2048 q90 → Export/Desk → destination").

The export dialog lists the presets on the left; the editor has the sections Location, File,
Content and Then send; the footer has "Export only" and the primary "Export & send".
