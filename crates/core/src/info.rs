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
        capture_time: Some(lr.timestamp())
            .filter(|&t| t > 0)
            .map(format_timestamp),
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

/// Formats seconds since the epoch as `YYYY-MM-DDTHH:MM:SS` (proleptic
/// Gregorian, no zone), using Hinnant's civil-from-days algorithm.
pub fn format_timestamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::fixtures;

    #[test]
    fn formats_known_timestamps() {
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00");
        assert_eq!(format_timestamp(951_782_400 + 3_661), "2000-02-29T01:01:01");
        assert_eq!(format_timestamp(1_700_000_000), "2023-11-14T22:13:20");
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
        }
    }
}
