//! Native core of editing-experiment: raw decode and previews on top of a
//! vendored LibRaw, exposed to Node via napi-rs.

pub mod api;
pub mod decode;
pub mod error;
pub mod ffi;
pub mod info;
pub mod libraw;
pub mod orient;
pub mod preview;
pub mod resample;

#[cfg(test)]
mod testutil;

use napi_derive::napi;

/// Version of the native core, taken from `Cargo.toml`.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Version of the native core addon, so JS can tell which binary it loaded.
#[napi]
pub fn core_version() -> String {
    version().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_cargo_manifest() {
        assert_eq!(version(), "0.0.0");
        assert_eq!(core_version(), version());
    }
}
