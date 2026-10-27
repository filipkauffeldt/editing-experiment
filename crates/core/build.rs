use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    napi_build::setup();
    build_libraw();
}

/// Recursively collects `.cpp` files, sorted so builds are reproducible.
fn collect_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| entry.expect("directory entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "cpp") {
            out.push(path);
        }
    }
}

/// Compiles the vendored LibRaw (C++) and our C shim into one static library.
///
/// Deliberately minimal so it builds on macOS/Windows without extra packages:
/// no OpenMP (the `_OPENMP` macro is never defined), no JPEG/zlib/lcms, no
/// demosaic packs, no RawSpeed/DNG SDK.
fn build_libraw() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let libraw = manifest.join("vendor/libraw");
    let shim = manifest.join("shim");

    let mut sources = Vec::new();
    collect_sources(&libraw.join("src"), &mut sources);

    let mut cpp = cc::Build::new();
    cpp.cpp(true)
        .files(&sources)
        .include(&libraw)
        // LibRaw is slow without optimisation, which makes `cargo test` unusable.
        .opt_level(2)
        .debug(false)
        .warnings(false)
        .extra_warnings(false)
        .define("LIBRAW_LIBRARY_BUILD", None)
        // Static linking: no __declspec(dllexport/dllimport) on Windows.
        .define("LIBRAW_NODLL", None);

    let target = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target == "msvc" {
        cpp.flag("/EHsc")
            .define("_CRT_SECURE_NO_WARNINGS", None)
            .define("WIN32_LEAN_AND_MEAN", None)
            .define("NOMINMAX", None);
    } else {
        cpp.std("c++14");
    }
    cpp.compile("raw");

    let mut c = cc::Build::new();
    c.file(shim.join("ee_libraw.c"))
        .include(&libraw)
        .define("LIBRAW_NODLL", None)
        .warnings(true);
    c.compile("ee_libraw_shim");

    println!("cargo:rerun-if-changed=vendor/libraw");
    println!("cargo:rerun-if-changed=shim");
    println!("cargo:rerun-if-changed=build.rs");
}
