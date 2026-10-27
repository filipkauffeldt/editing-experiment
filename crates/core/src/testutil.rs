//! Test helpers: locate the raw files used by tests.

use std::path::{Path, PathBuf};

/// NEF files from `fixtures/raw/` (see `pnpm fetch-fixtures`) and, when
/// `EE_SAMPLE_NEF_DIR` is set, the user's own samples. Empty (the test then
/// passes trivially, with a note) when neither exists.
pub fn fixtures() -> Vec<PathBuf> {
    let mut dirs = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/raw")];
    if let Some(dir) = std::env::var_os("EE_SAMPLE_NEF_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    let mut files: Vec<PathBuf> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("nef"))
        })
        .collect();
    files.sort();
    if files.is_empty() {
        eprintln!("skipping: no NEF fixtures (run `pnpm fetch-fixtures`)");
    }
    files
}
