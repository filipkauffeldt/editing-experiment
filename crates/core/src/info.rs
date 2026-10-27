//! `read_raw_info`: camera and exposure metadata plus image geometry.

use crate::error::Result;
use crate::libraw::LibRaw;
use crate::orient::oriented_size;
use std::path::Path;

/// Metadata of a raw file. Missing values are `None` (LibRaw reports 0 or an
/// empty string for tags the camera did not write).
#[derive(Debug, Clone, PartialEq)]
pub struct RawInfo {
    pub make: String,
    pub model: String,
    pub lens: Option<String>,
    pub serial: Option<String>,
    /// Camera local time, `YYYY-MM-DDTHH:MM:SS` without a zone designator
    /// (EXIF carries none), so `new Date(value)` yields the wall-clock time.
    pub capture_time: Option<String>,
    pub iso: Option<f64>,
    /// Exposure time in seconds.
    pub shutter: Option<f64>,
    /// F-number.
    pub aperture: Option<f64>,
    /// Focal length in millimetres.
    pub focal_length: Option<f64>,
    /// EXIF orientation, 1..=8.
    pub orientation: u8,
    /// Size of the sensor readout including masked border pixels.
    pub raw_width: u32,
    pub raw_height: u32,
    /// Size of the displayed image: the active area with `orientation` applied.
    pub width: u32,
    pub height: u32,
}

/// Reads metadata without decoding pixel data.
pub fn read_raw_info(path: &Path) -> Result<RawInfo> {
    let lr = LibRaw::open(path)?;
    Ok(info_of(&lr))
}

/// Builds the info from an already-open file.
pub(crate) fn info_of(lr: &LibRaw) -> RawInfo {
    let orientation = lr.orientation();
    let (image_w, image_h) = lr.image_size();
    let (width, height) = oriented_size(image_w, image_h, orientation);
    let (raw_width, raw_height) = lr.raw_size();

    let (make, model) = (
        first_non_empty([lr.normalized_make(), lr.make()]),
        first_non_empty([lr.normalized_model(), lr.model()]),
    );
    let lens = non_empty(first_non_empty([lr.lens_name(), lr.makernotes_lens_name()]))
        .or_else(|| focal_range_label(lr.lens_focal_range()));
    let serial = non_empty(first_non_empty([
        lr.body_serial(),
        lr.internal_body_serial(),
    ]));

    RawInfo {
        make,
        model,
        lens,
        serial,
        capture_time: lr.capture_time(),
        iso: positive(lr.iso()),
        shutter: positive(lr.shutter()),
        aperture: positive(lr.aperture()),
        focal_length: positive(lr.focal_length()),
        orientation,
        raw_width,
        raw_height,
        width,
        height,
    }
}

fn first_non_empty<const N: usize>(candidates: [String; N]) -> String {
    candidates
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}

fn non_empty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

/// Some bodies (e.g. a Z 6 with a lens LibRaw cannot name) write only the focal
/// range, so describe the lens by that rather than showing nothing.
fn focal_range_label((min, max): (f32, f32)) -> Option<String> {
    let (min, max) = (positive(min)?, positive(max)?);
    Some(if (min - max).abs() < 0.5 {
        format!("{min:.0}mm")
    } else {
        format!("{min:.0}-{max:.0}mm")
    })
}

fn positive(v: f32) -> Option<f64> {
    (v.is_finite() && v > 0.0).then_some(v as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::fixtures;

    #[test]
    fn capture_time_does_not_depend_on_the_host_time_zone() {
        // The Z 30 fixture was shot at 15:22:57 camera time; the test runs
        // under whatever TZ the host has (CI is UTC, developers are not).
        let Some(path) = fixtures()
            .into_iter()
            .find(|p| p.ends_with("z30_14bit.NEF"))
        else {
            return;
        };
        let info = read_raw_info(&path).unwrap();
        assert_eq!(info.capture_time.as_deref(), Some("2022-12-06T15:22:57"));
    }

    #[test]
    fn reads_nikon_z_fixtures() {
        for path in fixtures() {
            let info = read_raw_info(&path).unwrap();
            println!("{}: {info:?}", path.display());
            assert_eq!(info.make, "Nikon", "{}", path.display());
            assert!(info.model.starts_with("Z "), "{}", info.model);
            assert!(info.iso.unwrap() >= 50.0);
            assert!(info.shutter.unwrap() > 0.0);
            assert!(info.aperture.unwrap() >= 1.0);
            assert!(info.focal_length.unwrap() > 0.0);
            assert!((1..=8).contains(&info.orientation));
            assert!(info.raw_width >= info.width.min(info.height));
            assert!(info.width > 4000 && info.height > 3000, "{info:?}");
            let time = info.capture_time.expect("capture time");
            assert_eq!(time.len(), 19, "{time}");
            assert_eq!(&time[10..11], "T");
        }
    }
}
