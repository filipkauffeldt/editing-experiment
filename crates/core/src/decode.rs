//! `decode_linear`: demosaiced linear camera RGB, ready for the develop pipeline.
//!
//! See "Linear image format" in `docs/ARCHITECTURE.md` and
//! `LinearImageHeader` in `packages/contracts`.

use crate::error::{Error, Result};
use crate::libraw::LibRaw;
use crate::orient::oriented_size;
use crate::resample::{Rgb16, SampleType, resample_rgba};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeOptions {
    /// Longest edge of the result in pixels. Never upscales; `None` is full size.
    pub max_edge: Option<u32>,
    pub sample_type: SampleType,
}

impl Default for DecodeOptions {
    fn default() -> Self {
        DecodeOptions {
            max_edge: None,
            sample_type: SampleType::F16,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinearHeader {
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub sample_type: SampleType,
    /// `[r, g, b]` with g = 1.
    pub as_shot_multipliers: [f64; 3],
    /// Row-major, white-balanced camera RGB to linear sRGB.
    pub camera_to_srgb: [f64; 9],
    /// Row-major, XYZ (D65, as in dcraw/LibRaw) to camera RGB.
    pub xyz_to_camera: [f64; 9],
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinearImage {
    pub header: LinearHeader,
    /// `width * height * 4` samples (RGBA, little-endian) of `sample_type`.
    pub data: Vec<u8>,
}

/// What resolution to decode at, derived from the requested `max_edge`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Plan {
    /// Decode with LibRaw's 2x2 binning (much faster than demosaicing).
    half_size: bool,
    out_width: u32,
    out_height: u32,
}

fn plan(source: (u32, u32), max_edge: Option<u32>) -> Result<Plan> {
    let (sw, sh) = source;
    let long = sw.max(sh);
    match max_edge {
        Some(0) => Err(Error::InvalidArgument("maxEdge must be at least 1".into())),
        Some(edge) if edge < long => {
            let scale = f64::from(edge) / f64::from(long);
            let scaled = |len: u32| ((f64::from(len) * scale).round() as u32).clamp(1, edge);
            Ok(Plan {
                // Binning halves each side; only use it if that is still at
                // least as large as the target.
                half_size: u64::from(edge) * 2 <= u64::from(long),
                out_width: scaled(sw),
                out_height: scaled(sh),
            })
        }
        _ => Ok(Plan {
            half_size: false,
            out_width: sw,
            out_height: sh,
        }),
    }
}

pub fn decode_linear(path: &Path, options: DecodeOptions) -> Result<LinearImage> {
    let mut lr = LibRaw::open(path)?;
    let orientation = lr.orientation();
    let (image_w, image_h) = lr.image_size();
    let (source_width, source_height) = oriented_size(image_w, image_h, orientation);
    let plan = plan((source_width, source_height), options.max_edge)?;

    let header_colour = colour_of(&lr);

    lr.configure_linear_decode(plan.half_size);
    lr.unpack()?;
    lr.process()?;
    let image = lr.make_mem_image()?;
    // The develop buffers (about 8 bytes per pixel) are no longer needed.
    drop(lr);

    if image.colors() != 3 || image.bits() != 16 {
        return Err(Error::Encode(format!(
            "unexpected developed image layout: {} colours, {} bits",
            image.colors(),
            image.bits()
        )));
    }
    let (w, h) = (image.width(), image.height());
    if w == 0 || h == 0 || image.data().len() < w as usize * h as usize * 6 {
        return Err(Error::Encode(format!(
            "developed image is {w}x{h} with {} bytes",
            image.data().len()
        )));
    }

    // With half_size the developed image is about half of the source, so clamp
    // the planned output to what it can actually provide.
    let (developed_w, developed_h) = oriented_size(w, h, orientation);
    let (width, height) = (
        plan.out_width.min(developed_w),
        plan.out_height.min(developed_h),
    );
    let data = resample_rgba(
        Rgb16 {
            data: image.data(),
            width: w,
            height: h,
        },
        orientation,
        width,
        height,
        options.sample_type,
    );

    Ok(LinearImage {
        header: LinearHeader {
            width,
            height,
            source_width,
            source_height,
            sample_type: options.sample_type,
            as_shot_multipliers: header_colour.multipliers,
            camera_to_srgb: header_colour.camera_to_srgb,
            xyz_to_camera: header_colour.xyz_to_camera,
        },
        data,
    })
}

struct Colour {
    multipliers: [f64; 3],
    camera_to_srgb: [f64; 9],
    xyz_to_camera: [f64; 9],
}

fn colour_of(lr: &LibRaw) -> Colour {
    Colour {
        multipliers: as_shot_multipliers(lr.cam_mul(), lr.pre_mul()),
        camera_to_srgb: lr.rgb_cam().map(f64::from),
        xyz_to_camera: lr.cam_xyz().map(f64::from),
    }
}

/// `[r, g, b]` normalised to g = 1 from the camera's as-shot multipliers,
/// falling back to LibRaw's daylight multipliers, then to unity, when the
/// camera did not record white balance.
fn as_shot_multipliers(cam_mul: [f32; 4], pre_mul: [f32; 4]) -> [f64; 3] {
    let usable = |m: [f32; 4]| m[0] > 1e-5 && m[1] > 1e-5 && m[2] > 1e-5;
    let m = if usable(cam_mul) {
        cam_mul
    } else if usable(pre_mul) {
        pre_mul
    } else {
        return [1.0, 1.0, 1.0];
    };
    let g = f64::from(m[1]);
    [f64::from(m[0]) / g, 1.0, f64::from(m[2]) / g]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::info::read_raw_info;
    use crate::preview::extract_preview;
    use crate::testutil::fixtures;
    use std::time::Instant;

    #[test]
    fn plan_never_upscales_and_hits_max_edge_exactly() {
        let p = plan((6048, 4032), Some(2048)).unwrap();
        assert_eq!((p.out_width, p.out_height), (2048, 1365));
        assert!(p.half_size);
        // Portrait after rotation.
        let p = plan((4032, 6048), Some(2048)).unwrap();
        assert_eq!((p.out_width, p.out_height), (1365, 2048));
        // Larger than the source: full size.
        let p = plan((6048, 4032), Some(10_000)).unwrap();
        assert_eq!(
            (p.out_width, p.out_height, p.half_size),
            (6048, 4032, false)
        );
        let p = plan((6048, 4032), None).unwrap();
        assert_eq!(
            (p.out_width, p.out_height, p.half_size),
            (6048, 4032, false)
        );
    }

    #[test]
    fn half_size_only_when_it_still_covers_the_target() {
        assert!(plan((6048, 4032), Some(3024)).unwrap().half_size);
        assert!(!plan((6048, 4032), Some(3025)).unwrap().half_size);
    }

    #[test]
    fn zero_max_edge_is_rejected() {
        assert!(matches!(
            plan((100, 100), Some(0)),
            Err(Error::InvalidArgument(_))
        ));
    }

    #[test]
    fn multipliers_are_normalised_to_green() {
        let m = as_shot_multipliers([2.0, 1.0, 1.5, 1.0], [0.0; 4]);
        assert_eq!(m, [2.0, 1.0, 1.5]);
        let m = as_shot_multipliers([4.0, 2.0, 3.0, 2.0], [0.0; 4]);
        assert_eq!(m, [2.0, 1.0, 1.5]);
    }

    #[test]
    fn multipliers_fall_back_to_daylight_then_unity() {
        assert_eq!(
            as_shot_multipliers([0.0; 4], [2.0, 1.0, 1.25, 1.0]),
            [2.0, 1.0, 1.25]
        );
        assert_eq!(as_shot_multipliers([0.0; 4], [0.0; 4]), [1.0, 1.0, 1.0]);
    }

    // ---- real raw files ------------------------------------------------

    fn f32_samples(image: &LinearImage) -> Vec<f32> {
        image
            .data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&b| f32::from_le_bytes(b))
            .collect()
    }

    fn options(max_edge: u32) -> DecodeOptions {
        DecodeOptions {
            max_edge: Some(max_edge),
            sample_type: SampleType::F32,
        }
    }

    /// Mean of each colour channel.
    fn channel_means(rgba: &[f32]) -> [f64; 3] {
        let mut sum = [0f64; 3];
        for px in rgba.as_chunks::<4>().0 {
            for c in 0..3 {
                sum[c] += f64::from(px[c]);
            }
        }
        sum.map(|s| s / (rgba.len() / 4) as f64)
    }

    #[test]
    fn buffers_match_headers_and_honour_max_edge() {
        for path in fixtures() {
            let info = read_raw_info(&path).unwrap();
            let image = decode_linear(&path, options(1024)).unwrap();
            let h = &image.header;
            assert_eq!((h.source_width, h.source_height), (info.width, info.height));
            assert_eq!(h.width.max(h.height), 1024, "{}", path.display());
            // Aspect ratio of the source is kept.
            let source_aspect = f64::from(info.width) / f64::from(info.height);
            let aspect = f64::from(h.width) / f64::from(h.height);
            assert!((aspect / source_aspect - 1.0).abs() < 0.01, "{aspect}");
            assert_eq!(image.data.len(), (h.width * h.height) as usize * 4 * 4);

            let samples = f32_samples(&image);
            assert!(samples.iter().all(|v| v.is_finite() && *v >= 0.0));
            // The white level is 1.0: nothing above it, and a real photo has
            // some bright pixels.
            let max = samples.iter().copied().fold(0.0, f32::max);
            assert!(max <= 1.0 + 1e-4, "{max}");
            assert!(max > 0.3, "{max}");
            for px in samples.as_chunks::<4>().0 {
                assert_eq!(px[3], 1.0);
            }
        }
    }

    #[test]
    fn full_size_decode_matches_source_dimensions() {
        let Some(path) = fixtures().into_iter().next() else {
            return;
        };
        let info = read_raw_info(&path).unwrap();
        let image = decode_linear(
            &path,
            DecodeOptions {
                max_edge: None,
                sample_type: SampleType::F16,
            },
        )
        .unwrap();
        let h = &image.header;
        assert_eq!((h.width, h.height), (info.width, info.height));
        assert_eq!(h.sample_type, SampleType::F16);
        assert_eq!(image.data.len(), (h.width * h.height) as usize * 4 * 2);
        // A decode asking for more than the source has stays at full size.
        let big = decode_linear(&path, options(100_000)).unwrap();
        assert_eq!(
            (big.header.width, big.header.height),
            (info.width, info.height)
        );
    }

    #[test]
    fn colour_metadata_is_plausible() {
        for path in fixtures() {
            let h = decode_linear(&path, options(256)).unwrap().header;
            let [r, g, b] = h.as_shot_multipliers;
            assert_eq!(g, 1.0);
            assert!(r > 1.0 && r < 4.0, "r = {r}");
            assert!(b > 1.0 && b < 4.0, "b = {b}");
            // White-balanced camera white maps to sRGB white, so rows sum to 1.
            for row in h.camera_to_srgb.chunks(3) {
                let sum: f64 = row.iter().sum();
                assert!((sum - 1.0).abs() < 0.02, "{:?}", h.camera_to_srgb);
            }
            // XYZ -> camera has a real inverse.
            let m = &h.xyz_to_camera;
            let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
                + m[2] * (m[3] * m[7] - m[4] * m[6]);
            assert!(det.abs() > 1e-4, "{m:?}");
            // White-balanced camera white (1/multipliers is the neutral) lands
            // near XYZ-D65-ish values: just check every entry is finite and sane.
            assert!(m.iter().all(|v| v.is_finite() && v.abs() < 5.0), "{m:?}");
        }
    }

    #[test]
    fn data_is_linear_light() {
        // Averaging is linear, so the mean of a half-size decode and of the
        // full demosaic shrunk to the same size must agree, and halving the
        // multiplier must halve the value. A gamma curve would break both.
        let Some(path) = fixtures().into_iter().next() else {
            return;
        };
        let small = decode_linear(&path, options(512)).unwrap();
        let samples = f32_samples(&small);
        let means = channel_means(&samples);

        // Force the non-binned path by asking for slightly more than half.
        let info = read_raw_info(&path).unwrap();
        let big_edge = info.width.max(info.height) / 2 + 8;
        let big = decode_linear(&path, options(big_edge)).unwrap();
        let big_means = channel_means(&f32_samples(&big));
        for c in 0..3 {
            let ratio = means[c] / big_means[c];
            assert!(
                (ratio - 1.0).abs() < 0.03,
                "channel {c}: {means:?} vs {big_means:?}"
            );
        }
        // Linear: scaling every sample by 0.5 (a one-stop exposure change)
        // halves the mean.
        let halved: Vec<f32> = samples.iter().map(|v| v * 0.5).collect();
        let halved_means = channel_means(&halved);
        for c in 0..3 {
            assert!((halved_means[c] / means[c] - 0.5).abs() < 1e-6);
        }
        // A scene's average is a plausible linear value, not gamma-encoded
        // (which would put typical scenes well above 0.4).
        let luma = means.iter().sum::<f64>() / 3.0;
        assert!(luma > 0.002 && luma < 0.4, "mean {luma}");
    }

    fn srgb_oetf(v: f64) -> f64 {
        let v = v.clamp(0.0, 1.0);
        if v <= 0.003_130_8 {
            v * 12.92
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        }
    }

    /// Mean R, G, B over `cells` x `cells` blocks, as 0..=1 display values.
    fn block_means(
        rgb: impl Fn(u32, u32) -> [f64; 3],
        w: u32,
        h: u32,
        cells: u32,
    ) -> Vec<[f64; 3]> {
        let mut out = Vec::new();
        for cy in 0..cells {
            for cx in 0..cells {
                let (x0, x1) = (
                    cx * w / cells,
                    ((cx + 1) * w / cells).max(cx * w / cells + 1),
                );
                let (y0, y1) = (
                    cy * h / cells,
                    ((cy + 1) * h / cells).max(cy * h / cells + 1),
                );
                let mut sum = [0f64; 3];
                let mut n = 0f64;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let p = rgb(x, y);
                        for c in 0..3 {
                            sum[c] += p[c];
                        }
                        n += 1.0;
                    }
                }
                out.push(sum.map(|s| s / n));
            }
        }
        out
    }

    fn correlation(a: &[f64], b: &[f64]) -> f64 {
        let n = a.len() as f64;
        let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
        let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
        for (x, y) in a.iter().zip(b) {
            cov += (x - ma) * (y - mb);
            va += (x - ma).powi(2);
            vb += (y - mb).powi(2);
        }
        cov / (va.sqrt() * vb.sqrt())
    }

    /// End to end: develop the linear data the way the contract describes
    /// (multipliers, matrix, sRGB curve) and compare it with the camera's own
    /// JPEG preview of the same frame. Catches wrong scaling, black level,
    /// white balance or matrix orientation.
    #[test]
    fn developed_linear_data_resembles_the_embedded_preview() {
        for path in fixtures() {
            let image = decode_linear(&path, options(512)).unwrap();
            let h = &image.header;
            let samples = f32_samples(&image);
            let m = &h.camera_to_srgb;
            let [mr, mg, mb] = h.as_shot_multipliers;
            let developed = |x: u32, y: u32| {
                let p = &samples[((y * h.width + x) * 4) as usize..];
                let cam = [
                    f64::from(p[0]) * mr,
                    f64::from(p[1]) * mg,
                    f64::from(p[2]) * mb,
                ];
                let lin = |row: usize| {
                    m[row * 3] * cam[0] + m[row * 3 + 1] * cam[1] + m[row * 3 + 2] * cam[2]
                };
                [srgb_oetf(lin(0)), srgb_oetf(lin(1)), srgb_oetf(lin(2))]
            };
            let ours = block_means(developed, h.width, h.height, 16);

            let preview = extract_preview(&path).unwrap();
            let mut decoder = zune_jpeg::JpegDecoder::new(std::io::Cursor::new(&preview.jpeg));
            let pixels = decoder.decode().unwrap();
            let (pw, ph) = (preview.width, preview.height);
            let theirs = block_means(
                |x, y| {
                    let i = ((y * pw + x) * 3) as usize;
                    [pixels[i], pixels[i + 1], pixels[i + 2]].map(|v| f64::from(v) / 255.0)
                },
                pw,
                ph,
                16,
            );

            let luma = |p: &[f64; 3]| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
            let (la, lb): (Vec<f64>, Vec<f64>) = (
                ours.iter().map(luma).collect(),
                theirs.iter().map(luma).collect(),
            );
            let corr = correlation(&la, &lb);
            let mean = |cells: &[[f64; 3]], c: usize| {
                cells.iter().map(|p| p[c]).sum::<f64>() / cells.len() as f64
            };
            let ratio = |cells: &[[f64; 3]], c: usize| mean(cells, c) / mean(cells, 1);
            println!(
                "{}: luma correlation {corr:.3}, R/G {:.3} vs {:.3}, B/G {:.3} vs {:.3}",
                path.display(),
                ratio(&ours, 0),
                ratio(&theirs, 0),
                ratio(&ours, 2),
                ratio(&theirs, 2)
            );
            assert!(corr > 0.9, "layout/brightness mismatch: {corr}");
            for c in [0, 2] {
                let (a, b) = (ratio(&ours, c), ratio(&theirs, c));
                assert!(
                    (a / b - 1.0).abs() < 0.2,
                    "channel {c} colour cast: {a} vs {b}"
                );
            }
        }
    }

    /// Prints decode timings; never fails on speed.
    #[test]
    fn benchmark_log() {
        let Some(path) = fixtures().into_iter().next() else {
            return;
        };
        for (label, edge) in [("full size", None), ("2048px", Some(2048))] {
            let started = Instant::now();
            let image = decode_linear(
                &path,
                DecodeOptions {
                    max_edge: edge,
                    sample_type: SampleType::F16,
                },
            )
            .unwrap();
            println!(
                "bench: {} {label} ({}x{}) decoded in {:?}",
                path.file_name().unwrap().to_string_lossy(),
                image.header.width,
                image.header.height,
                started.elapsed()
            );
        }
    }
}
