//! Pure-Rust JPEG decode, resize and encode for 8-bit sRGB RGBA images.
//!
//! This replaces what the app used `sharp` for. Every function here works on
//! owned buffers and is synchronous; [`crate::api`] runs them on the libuv
//! threadpool.
//!
//! Resizing works on the sRGB-encoded values directly (no linearisation):
//! that matches what other photo tools do for exports and previews, is about
//! twice as fast, and the ringing/darkening differences are invisible at
//! photographic downscale ratios.

use crate::error::{Error, Result};
use crate::orient::OrientMap;
use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

/// Compact ICC v2 sRGB profile (CC0, see `assets/README.md`).
pub const SRGB_ICC: &[u8] = include_bytes!("../assets/sRGB-v2-magic.icc");

/// 8-bit RGBA pixels, row-major, straight alpha.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba8 {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chroma {
    /// 4:4:4, no subsampling.
    C444,
    /// 4:2:0.
    C420,
}

#[derive(Debug, Clone, Copy)]
pub struct EncodeOptions {
    pub quality: u8,
    pub chroma: Chroma,
    pub icc_srgb: bool,
    pub progressive: bool,
}

/// Decodes a JPEG to RGBA. With `orient` the EXIF orientation is applied, so
/// the result is upright; without it the pixels are as stored.
pub fn decode_jpeg(jpeg: &[u8], orient: bool) -> Result<Rgba8> {
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
    let mut decoder =
        JpegDecoder::new_with_options(zune_core::bytestream::ZCursor::new(jpeg), options);
    let rgba = decoder
        .decode()
        .map_err(|e| Error::Decode(format!("{e:?}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| Error::Decode("missing image info".into()))?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(Error::Decode(format!(
            "unexpected {} byte buffer for a {width}x{height} JPEG (CMYK or unsupported colour space?)",
            rgba.len()
        )));
    }
    let image = Rgba8 {
        width,
        height,
        rgba,
    };
    let orientation = if orient {
        decoder
            .exif()
            .and_then(|e| exif_orientation(e))
            .unwrap_or(1)
    } else {
        1
    };
    Ok(apply_orientation(image, orientation))
}

/// Rotates/mirrors `image` so that it displays upright for EXIF `orientation`.
pub fn apply_orientation(image: Rgba8, orientation: u8) -> Rgba8 {
    if !(2..=8).contains(&orientation) {
        return image;
    }
    let map = OrientMap::new(image.width, image.height, orientation);
    let mut out = Vec::with_capacity(image.rgba.len());
    for y in 0..map.height {
        for x in 0..map.width {
            let i = map.index(x, y) * 4;
            out.extend_from_slice(&image.rgba[i..i + 4]);
        }
    }
    Rgba8 {
        width: map.width,
        height: map.height,
        rgba: out,
    }
}

/// Reads the Orientation tag (0x0112) from IFD0 of a TIFF block (the EXIF
/// payload without the `Exif\0\0` header). `None` if absent or invalid.
pub fn exif_orientation(tiff: &[u8]) -> Option<u8> {
    let tiff = tiff.strip_prefix(b"Exif\0\0").unwrap_or(tiff);
    let little = match tiff.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b: [u8; 2] = tiff.get(at..at + 2)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = tiff.get(at..at + 4)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let count = usize::from(u16_at(ifd)?);
    for i in 0..count {
        let entry = ifd + 2 + i * 12;
        if u16_at(entry)? == 0x0112 {
            // SHORT, count 1: the value sits in the first two bytes of the field.
            let value = u16_at(entry + 8)?;
            return u8::try_from(value).ok().filter(|v| (1..=8).contains(v));
        }
    }
    None
}

/// Size that fits `width` x `height` into `max_edge` on the longest edge,
/// keeping the aspect ratio. Never upscales.
pub fn fit_size(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge {
        return (width, height);
    }
    let scale = f64::from(max_edge) / f64::from(longest);
    let scaled = |v: u32| ((f64::from(v) * scale).round() as u32).max(1);
    (scaled(width), scaled(height))
}

/// Resizes `rgba` (a `width` x `height` image) to exactly `out_w` x `out_h`
/// with Lanczos3 (the kernel widens when shrinking, so no aliasing).
pub fn resize_exact(rgba: &[u8], width: u32, height: u32, out_w: u32, out_h: u32) -> Result<Rgba8> {
    if out_w == 0 || out_h == 0 {
        return Err(Error::InvalidArgument(format!(
            "cannot resize to {out_w}x{out_h}"
        )));
    }
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(Error::InvalidArgument(format!(
            "{} bytes is not a {width}x{height} RGBA image",
            rgba.len()
        )));
    }
    let src = ImageRef::new(width, height, rgba, PixelType::U8x4)
        .map_err(|e| Error::InvalidArgument(e.to_string()))?;
    if (out_w, out_h) == (width, height) {
        return Ok(Rgba8 {
            width,
            height,
            rgba: rgba.to_vec(),
        });
    }
    let mut dst = Image::new(out_w, out_h, PixelType::U8x4);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    Resizer::new()
        .resize(&src, &mut dst, &options)
        .map_err(|e| Error::Resize(e.to_string()))?;
    Ok(Rgba8 {
        width: out_w,
        height: out_h,
        rgba: dst.into_vec(),
    })
}

/// Downscales so the longest edge is at most `max_edge`; never upscales.
pub fn resize_max_edge(rgba: &[u8], width: u32, height: u32, max_edge: u32) -> Result<Rgba8> {
    if max_edge == 0 {
        return Err(Error::InvalidArgument("maxEdge must be positive".into()));
    }
    let (w, h) = fit_size(width, height, max_edge);
    resize_exact(rgba, width, height, w, h)
}

/// Encodes RGBA (alpha ignored) as a baseline sequential JPEG. Output holds a
/// JFIF header without thumbnail, optionally an ICC profile, and nothing else.
pub fn encode_jpeg(image: &Rgba8, options: EncodeOptions) -> Result<Vec<u8>> {
    if options.quality == 0 || options.quality > 100 {
        return Err(Error::InvalidArgument("quality must be 1..=100".to_owned()));
    }
    let too_large = || Error::TooLarge {
        width: image.width,
        height: image.height,
    };
    let width = u16::try_from(image.width).map_err(|_| too_large())?;
    let height = u16::try_from(image.height).map_err(|_| too_large())?;
    if width == 0
        || height == 0
        || image.rgba.len() != image.width as usize * image.height as usize * 4
    {
        return Err(Error::InvalidArgument(format!(
            "{} bytes is not a {}x{} RGBA image",
            image.rgba.len(),
            image.width,
            image.height
        )));
    }
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, options.quality);
    encoder.set_sampling_factor(match options.chroma {
        Chroma::C444 => SamplingFactor::R_4_4_4,
        Chroma::C420 => SamplingFactor::R_4_2_0,
    });
    encoder.set_progressive(options.progressive);
    if options.icc_srgb {
        encoder
            .add_icc_profile(SRGB_ICC)
            .map_err(|e| Error::Encode(e.to_string()))?;
    }
    encoder
        .encode(&image.rgba, width, height, ColorType::Rgba)
        .map_err(|e| Error::Encode(e.to_string()))?;
    Ok(out)
}

/// A thumbnail and a preview JPEG made from one decode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Previews {
    pub thumb: Vec<u8>,
    pub preview: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
pub struct PreviewOptions {
    pub thumb_edge: u32,
    pub preview_edge: u32,
    pub quality: u8,
}

/// Decodes `jpeg` once, orients it and encodes a thumbnail and a preview
/// (4:2:0, sRGB, no metadata).
pub fn make_previews(jpeg: &[u8], options: PreviewOptions) -> Result<Previews> {
    let image = decode_jpeg(jpeg, true)?;
    let encode = |edge: u32| -> Result<Vec<u8>> {
        encode_jpeg(
            &resize_max_edge(&image.rgba, image.width, image.height, edge)?,
            EncodeOptions {
                quality: options.quality,
                chroma: Chroma::C420,
                icc_srgb: true,
                progressive: false,
            },
        )
    };
    Ok(Previews {
        // Larger first so a failure of the big one is reported before work on the small one.
        preview: encode(options.preview_edge)?,
        thumb: encode(options.thumb_edge)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smooth, asymmetric test image: red grows to the right, green downwards,
    /// blue is high only in the top-left quarter. JPEG-friendly (no hard edges
    /// inside blocks except the blue step, which sits on a block boundary).
    fn pattern(width: u32, height: u32) -> Rgba8 {
        let mut rgba = Vec::new();
        for y in 0..height {
            for x in 0..width {
                let blue = if x < width / 2 && y < height / 2 {
                    230
                } else {
                    20
                };
                rgba.extend_from_slice(&[
                    (x * 255 / (width - 1)) as u8,
                    (y * 255 / (height - 1)) as u8,
                    blue,
                    255,
                ]);
            }
        }
        Rgba8 {
            width,
            height,
            rgba,
        }
    }

    fn opts(quality: u8, chroma: Chroma, icc_srgb: bool) -> EncodeOptions {
        EncodeOptions {
            quality,
            chroma,
            icc_srgb,
            progressive: false,
        }
    }

    fn mean_abs_error(a: &Rgba8, b: &Rgba8) -> f64 {
        assert_eq!((a.width, a.height), (b.width, b.height));
        let total: u64 = a
            .rgba
            .as_chunks::<4>()
            .0
            .iter()
            .zip(b.rgba.as_chunks::<4>().0)
            .flat_map(|(p, q)| (0..3).map(move |c| u64::from(p[c].abs_diff(q[c]))))
            .sum();
        total as f64 / (a.rgba.len() / 4 * 3) as f64
    }

    /// Minimal EXIF block (little endian) holding only the Orientation tag.
    fn exif_with_orientation(orientation: u16) -> Vec<u8> {
        let mut t = b"Exif\0\0II*\0".to_vec();
        t.extend_from_slice(&[8, 0, 0, 0]); // IFD0 at offset 8
        t.extend_from_slice(&[1, 0]); // one entry
        t.extend_from_slice(&0x0112u16.to_le_bytes());
        t.extend_from_slice(&3u16.to_le_bytes()); // SHORT
        t.extend_from_slice(&1u32.to_le_bytes());
        t.extend_from_slice(&orientation.to_le_bytes());
        t.extend_from_slice(&[0, 0]);
        t.extend_from_slice(&[0, 0, 0, 0]); // no next IFD
        t
    }

    fn jpeg_with_orientation(image: &Rgba8, orientation: u16) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = Encoder::new(&mut out, 100);
        encoder.set_sampling_factor(SamplingFactor::R_4_4_4);
        encoder
            .add_exif_metadata(&exif_with_orientation(orientation))
            .unwrap();
        encoder
            .encode(
                &image.rgba,
                image.width as u16,
                image.height as u16,
                ColorType::Rgba,
            )
            .unwrap();
        out
    }

    /// The EXIF definition written as "which source pixel shows at display
    /// (x, y)", independent of `OrientMap`.
    fn expected_pixel(src: &Rgba8, orientation: u8, x: u32, y: u32) -> [u8; 4] {
        let (w, h) = (src.width, src.height);
        let (sx, sy) = match orientation {
            1 => (x, y),
            2 => (w - 1 - x, y),
            3 => (w - 1 - x, h - 1 - y),
            4 => (x, h - 1 - y),
            5 => (y, x),
            6 => (y, h - 1 - x),
            7 => (w - 1 - y, h - 1 - x),
            8 => (w - 1 - y, x),
            _ => unreachable!(),
        };
        let i = ((sy * w + sx) * 4) as usize;
        src.rgba[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn decode_applies_each_of_the_eight_exif_orientations() {
        let source = pattern(48, 32);
        for orientation in 1..=8u8 {
            let jpeg = jpeg_with_orientation(&source, u16::from(orientation));
            let decoded = decode_jpeg(&jpeg, true).unwrap();
            let swapped = orientation >= 5;
            assert_eq!(
                (decoded.width, decoded.height),
                if swapped { (32, 48) } else { (48, 32) },
                "orientation {orientation}"
            );
            let mut worst = 0u8;
            for y in 0..decoded.height {
                for x in 0..decoded.width {
                    let want = expected_pixel(&source, orientation, x, y);
                    let i = ((y * decoded.width + x) * 4) as usize;
                    for (c, &w) in want.iter().take(3).enumerate() {
                        worst = worst.max(w.abs_diff(decoded.rgba[i + c]));
                    }
                }
            }
            // q100 4:4:4 JPEG error, with slack for the blue step.
            assert!(
                worst <= 40,
                "orientation {orientation}: worst error {worst}"
            );
        }
    }

    #[test]
    fn decode_can_skip_orientation() {
        let jpeg = jpeg_with_orientation(&pattern(48, 32), 6);
        let decoded = decode_jpeg(&jpeg, false).unwrap();
        assert_eq!((decoded.width, decoded.height), (48, 32));
    }

    #[test]
    fn missing_or_invalid_orientation_means_upright() {
        let source = pattern(16, 16);
        let mut plain = Vec::new();
        Encoder::new(&mut plain, 90)
            .encode(&source.rgba, 16, 16, ColorType::Rgba)
            .unwrap();
        assert_eq!(decode_jpeg(&plain, true).unwrap().width, 16);
        assert_eq!(exif_orientation(&exif_with_orientation(9)), None);
        assert_eq!(exif_orientation(&exif_with_orientation(0)), None);
        assert_eq!(exif_orientation(b"garbage"), None);
        assert_eq!(exif_orientation(&exif_with_orientation(3)), Some(3));
    }

    #[test]
    fn decode_rejects_non_jpeg() {
        assert!(matches!(
            decode_jpeg(b"not a jpeg", true),
            Err(Error::Decode(_))
        ));
    }

    #[test]
    fn fit_size_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_size(6000, 4000, 1500), (1500, 1000));
        assert_eq!(fit_size(4000, 6000, 1500), (1000, 1500));
        assert_eq!(fit_size(100, 50, 200), (100, 50));
        assert_eq!(fit_size(100, 50, 100), (100, 50));
        assert_eq!(fit_size(10_000, 1, 100), (100, 1));
    }

    #[test]
    fn resize_downscales_a_gradient_without_visible_error() {
        let big = pattern(800, 600);
        let small = resize_max_edge(&big.rgba, big.width, big.height, 200).unwrap();
        assert_eq!((small.width, small.height), (200, 150));
        // The gradient is linear, so the small version is the same gradient
        // sampled at the pixel centres.
        let reference = pattern(200, 150);
        let error = mean_abs_error(&small, &reference);
        assert!(error < 2.5, "mean abs error {error}");
        assert!(small.rgba.as_chunks::<4>().0.iter().all(|p| p[3] == 255));
    }

    #[test]
    fn resize_preserves_flat_colour_and_exact_size() {
        let flat = Rgba8 {
            width: 64,
            height: 48,
            rgba: [200, 100, 50, 255].repeat(64 * 48),
        };
        let out = resize_exact(&flat.rgba, 64, 48, 17, 9).unwrap();
        assert_eq!((out.width, out.height), (17, 9));
        assert!(
            out.rgba
                .as_chunks::<4>()
                .0
                .iter()
                .all(|p| *p == [200, 100, 50, 255])
        );
        assert!(resize_exact(&flat.rgba, 64, 48, 0, 5).is_err());
        assert!(
            resize_exact(&flat.rgba, 64, 47, 5, 5).is_err(),
            "length mismatch"
        );
    }

    #[test]
    fn resize_does_not_upscale_through_max_edge() {
        let small = pattern(20, 10);
        assert_eq!(resize_max_edge(&small.rgba, 20, 10, 100).unwrap(), small);
    }

    #[test]
    fn encode_then_decode_round_trips_with_low_error() {
        let source = pattern(120, 80);
        for (quality, chroma, limit) in [(95, Chroma::C444, 1.5), (80, Chroma::C420, 4.0)] {
            let jpeg = encode_jpeg(&source, opts(quality, chroma, true)).unwrap();
            let decoded = decode_jpeg(&jpeg, true).unwrap();
            let error = mean_abs_error(&source, &decoded);
            assert!(error < limit, "q{quality} {chroma:?}: error {error}");
        }
    }

    /// Marker segments of a JPEG up to SOS as `(marker, payload)`.
    fn segments(jpeg: &[u8]) -> Vec<(u8, &[u8])> {
        assert_eq!(jpeg[..2], [0xff, 0xd8]);
        let mut out = Vec::new();
        let mut i = 2;
        loop {
            assert_eq!(jpeg[i], 0xff);
            let marker = jpeg[i + 1];
            let len = usize::from(u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]));
            out.push((marker, &jpeg[i + 4..i + 2 + len]));
            i += 2 + len;
            if marker == 0xda {
                return out;
            }
        }
    }

    #[test]
    fn output_has_only_jfif_and_optionally_icc() {
        let image = pattern(64, 64);
        for icc in [false, true] {
            let jpeg = encode_jpeg(&image, opts(90, Chroma::C444, icc)).unwrap();
            let apps: Vec<_> = segments(&jpeg)
                .into_iter()
                .filter(|(m, _)| (0xe0..=0xef).contains(m))
                .collect();
            let jfif = apps[0];
            assert_eq!(jfif.0, 0xe0);
            assert!(jfif.1.starts_with(b"JFIF\0"));
            assert_eq!(jfif.1[12..14], [0, 0], "JFIF thumbnail size");
            if icc {
                assert_eq!(apps.len(), 2);
                assert_eq!(apps[1].0, 0xe2);
                assert!(apps[1].1.starts_with(b"ICC_PROFILE\0"));
                assert_eq!(&apps[1].1[14..], SRGB_ICC);
            } else {
                assert_eq!(apps.len(), 1, "no ICC unless asked");
            }
            assert_eq!(jpeg[jpeg.len() - 2..], [0xff, 0xd9]);
        }
    }

    #[test]
    fn chroma_option_controls_subsampling_and_progressive_is_off() {
        let image = pattern(64, 64);
        for (chroma, luma_sampling) in [(Chroma::C444, 0x11), (Chroma::C420, 0x22)] {
            let jpeg = encode_jpeg(&image, opts(90, chroma, false)).unwrap();
            let segs = segments(&jpeg);
            let (marker, sof) = segs.iter().find(|(m, _)| matches!(m, 0xc0..=0xc2)).unwrap();
            assert_eq!(*marker, 0xc0, "baseline sequential");
            // precision, height, width, count, then (id, sampling, tq) per component.
            assert_eq!(sof[5], 3);
            assert_eq!(sof[7], luma_sampling);
            assert_eq!(sof[10], 0x11);
            assert_eq!(sof[13], 0x11);
        }
    }

    #[test]
    fn encode_rejects_bad_input() {
        let image = pattern(8, 8);
        assert!(encode_jpeg(&image, opts(0, Chroma::C444, false)).is_err());
        assert!(encode_jpeg(&image, opts(101, Chroma::C444, false)).is_err());
        let truncated = Rgba8 {
            rgba: vec![0; 10],
            ..image
        };
        assert!(matches!(
            encode_jpeg(&truncated, opts(90, Chroma::C444, false)),
            Err(Error::InvalidArgument(_))
        ));
    }

    #[test]
    fn make_previews_orients_and_sizes_both_outputs() {
        let source = pattern(300, 200);
        let jpeg = jpeg_with_orientation(&source, 6);
        let previews = make_previews(
            &jpeg,
            PreviewOptions {
                thumb_edge: 60,
                preview_edge: 150,
                quality: 85,
            },
        )
        .unwrap();
        let thumb = decode_jpeg(&previews.thumb, false).unwrap();
        let preview = decode_jpeg(&previews.preview, false).unwrap();
        // Orientation 6 makes the 300x200 source portrait.
        assert_eq!((thumb.width, thumb.height), (40, 60));
        assert_eq!((preview.width, preview.height), (100, 150));
        // Outputs are upright and carry no EXIF, so no second rotation.
        assert!(
            segments(&previews.thumb)
                .iter()
                .all(|(m, p)| *m != 0xe1 || !p.starts_with(b"Exif"))
        );
    }
}
