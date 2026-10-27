# Vendored LibRaw

- Upstream: https://github.com/LibRaw/LibRaw
- Version: **0.22.3** (tag `0.22.3`, commit `75d1532`)
- Licence: dual LGPL-2.1 (`LICENSE.LGPL`) or CDDL-1.0 (`LICENSE.CDDL`); see `COPYRIGHT`.
  We use it under the LGPL-2.1, which is GPL-3.0 compatible.

Only the parts needed to build the library are included: `libraw/` (public
headers), `internal/` (private headers), and `src/`. Not included: the
GPL2/GPL3 demosaic packs, RawSpeed and DNG SDK glue (`src/integration`), the
build systems, samples and docs. The sources are unmodified.

To update: replace these directories from a new upstream release, update the
version above, and check `crates/core/build.rs` for new source files.
