//! Native core of editing-experiment. Wave 0 only proves the napi-rs toolchain
//! (build, load from Node, call); LibRaw and the decode API come later.

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
