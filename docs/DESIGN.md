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
- tiny status dots (`--ok`, `--error`): the top bar, toast status; and the failed-upload icon
  on a thumbnail, which is drawn in `--error`.

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
  typeable. While typing, an in-range value applies live and an out-of-range one waits for
  Enter or blur, which clamps and rounds it; Escape restores the focused value. Double-click
  resets. Temperature and tint tracks carry the desaturated gradients (3 px so the colour
  reads).
- **NumberField**: the same mono, right-aligned value at a fixed width next to a toolbar slider
  (retouch block size and face padding, crop angle), keeping a local draft until Enter or blur.
  It commits a parsed, clamped value; an empty or invalid draft restores the current value.
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
- **Profile** (top of Basic in Develop): an underline Select grouped *Adobe Raw / Camera Matching /
  Other*, an Amount slider only for looks that have one, a muted note, and a text button *Browse
  profile folders…*. A profile that is not on this machine is a plain muted line with an `--error`
  status dot, not a coloured box.
- **Tag**: an 11 px square, filled white when tagged.
- **Status overlays** on thumbnails: one row of small monochrome icons on a scrim, bottom-left,
  all the same size and never wrapping. In order: edited (sliders) or retouched (mosaic), the
  export step (a spinning ring while queued or exporting, then the export arrow), the upload step
  (clock when queued, a bobbing arrow over a thin progress line while sending, a tick over a tray
  once sent), and not-equal when the metadata differs from the ingest template. A failed upload is
  a warning icon in `--error`. There are no words on the photo; every icon has a tooltip (the
  sending percentage is in it) and an accessible label.

## Layout

- **Top bar** (36 px): app mark, module switch (**Ingest · Library · Develop**) and
  right-aligned activity, shown only while it is true: **Ingesting 212 of 412**,
  **Watching FTP**, **Sending 2**, a red-dot **1 ingest failed** / **2 ingests failed**
  (opens Ingest) and a red-dot **1 failed** (opens the upload queue). Shortcuts and settings
  sit at the far right.
- **Dialogs** state the job in the title and carry no explaining subtitle. Title-related
  actions such as All and None sit on the title row. A dialog that copies from a photo names
  that photo's file in the title (*Copy metadata from _DSC8330.NEF*).
- **Bottom action bar** (40 px): contextual actions on the right, a summary on the left (and
  keyboard hints where a view has no other place for them).
- **Side panels**: the Library sidebar and inspector, the Develop metadata and develop panels,
  and the Ingest sources panel have a 1 px hairline on their inner edge that is a drag handle.
  It sits on the centre side of the edge, so a panel's scrollbar stays clear, and its invisible
  hit area reaches a few pixels into the centre. The line turns white on hover and while dragging, the
  width follows the pointer live, and the cursor is `col-resize` even when the pointer leaves
  the handle. Each panel has a content-aware minimum and maximum; the centre keeps at least
  320 px, and a smaller window re-clamps the shown widths without losing the saved preference.
  Double-click resets a panel to its default. Widths are saved to settings when the drag ends,
  not on every move, and are restored on the next launch.
- **Settings → Sources** lists the sources and adds a new one from a single **Add ▾** menu
  (Folder, Card, FTP, SFTP), rather than one button per kind.

### Modules

| Module  | Key | What it is                                                                         |
| ------- | --- | ---------------------------------------------------------------------------------- |
| Ingest  |     | From (sources, progress) and To (folder, names, preview), one action bar           |
| Library | `G` | folders, virtualised grid, inspector; `E` opens the loupe                          |
| Develop | `D` | metadata, photo, develop sliders, film strip                                       |
| Retouch | `R` | the retouch session on the Develop layout (`R`, or the Retouch button); leaving it saves first |

The Library's **Folders** are the local ingest copies only. They are derived from each photo's
own path (always its copy in the ingest destination), never from the configured sources, so a
card or a remote server can not appear there. Ingest always copies; editing only ever happens
on the copies. The sidebar is the folder list and nothing else.

### Filter bar

Library and Develop share one filter bar (`FilterBar`) and one filter state, so what is set in one
view is still set after `G`/`D`. A single 36 px row, left to right: **Tag** (All · Tagged ·
Untagged, with counts, underline on the active one), **five stars** (click star N for "N and up",
click the active star to clear; filled stars are white, the rest `--dim`), the **eight colour-class
dots** (several at once; a ticked dot has a 1 px white outline), a **Status** menu (Not sent,
Failed, Edited, Metadata differs, ticked boxes, counts), a **Camera** menu (one group of bodies, one
of sources), the **search** field (underline field, "Search…"; Ctrl/Cmd+`F` focuses it in both
views, Enter applies it and leaves, Esc clears it and leaves, and nothing typed in it is a shortcut), then a **×** that
appears only while something is filtered, the count (`N of M` while filtered), and on the right the
**Sort** menu (Name, Time) and a slot for the view's own controls (the Library's thumbnail size).
Menus are text with a small caret and a hairline popover; checks are 9 px squares, radios 9 px
circles, filled white when on. When a filter shows nothing the grid or film strip gives way to a
line saying photos are hidden, not lost, and a *Clear filters* button.

Library keys: click, Shift-range, Ctrl/Cmd-toggle, Ctrl/Cmd+A, arrows (Shift extends), `T` tag,
`1`-`5` rating (`0` clears), Ctrl/Cmd+`1`-`8` class (Ctrl/Cmd+`0` clears), Ctrl/Cmd+I caption, Ctrl/Cmd+K keywords, Shift+Ctrl/Cmd+C copy settings, Shift+Ctrl/Cmd+V paste
settings, Shift+Ctrl/Cmd+E export, Shift+Ctrl/Cmd+Enter export and send. The bottom bar has the
selection count on the left and **Caption…**, **Sync settings…** (the same group dialog for the
whole selection), **Export…** and the primary **Export & send** on the right; Tag, rating and class
are the keys above and the right-click menu, not buttons. In Develop Ctrl/Cmd+Enter is Next & send, and its bar shows the active export preset
("Desk 2048 q90 → Export/Desk → destination").

### Ingest

Two columns that read as one sentence, with the action in a bar that is always there.

- **From** (left, the resizable panel): one list of cards, folders and servers. A row is a square
  tickbox, the name, a mono count or kind on the right and one `--dim` detail line. The detail line
  holds the location and the filters that are not the default; it is a button that opens that source's
  filter controls inline, below the row. No boxes between rows, only the 1 px hairline.
- **To** (right): label and field pairs in a grid (labels `--muted`, fields boxed hairlines). Browse and
  the `{ }` variable picker are compact actions inside the field's box, separated by a hairline. Below the
  fields a hairline box shows the path of the first file in mono, with a `--dim` note, or the reason a
  template cannot be used. At 1440 px and wider the form and *Apply on the way in* sit side by side; a
  narrower column stacks them, and a window under 900 px stacks From above To.
- **Bar**: the summary on the left, the primary button on the right (the one white button). It reads
  `Ingest` or `Ingest N photos`, is disabled with its reason in the summary when nothing can start, and
  becomes `Stop all` while sources run. There is no Save: a failed automatic save shows `Not saved: …`
  with an `--error` dot under the form.

The export dialog lists the presets on the left; the editor is one compact label-left form
(Folder with its `{ }` variable picker and a live **Saves to** path, File names, If it exists,
Size and JPEG quality, Sharpen, Metadata, Version, Send to). A single footer row has the preset
actions (Save preset with an unsaved dot, Set as active for a non-active preset, Delete preset)
on the left and "Export only" and the primary "Export & send" on the right.
