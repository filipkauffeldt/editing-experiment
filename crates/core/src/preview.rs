//! `extract_preview`: the largest embedded preview of a raw file as a JPEG.

use crate::error::{Error, Result};
use crate::libraw::{LibRaw, MemImage, MemImageKind, ThumbInfo};
use std::path::Path;

/// JPEG quality used when an embedded preview is a bitmap and must be encoded.
const BITMAP_JPEG_QUALITY: u8 = 90;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    /// A complete JPEG file.
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// EXIF orientation (1..=8) to apply to the preview for display. Embedded
    /// previews are stored in sensor orientation, so this is the raw's own.
    pub orientation: u8,
}

/// Extracts the largest embedded preview. JPEG previews are returned
/// byte-for-byte; bitmap previews are encoded to JPEG.
pub fn extract_preview(path: &Path) -> Result<Preview> {
    let mut lr = LibRaw::open(path)?;
    let orientation = lr.orientation();
    let thumb = best_thumbnail(&lr.thumbnails()).ok_or_else(|| Error::NoPreview {
        path: path.to_owned(),
    })?;
    lr.unpack_thumb(thumb.index)?;
    let image = lr.make_mem_thumb()?;

    let (jpeg, width, height) = match image.kind() {
        MemImageKind::Jpeg => {
            let jpeg = image.data().to_vec();
            // Trust the stream over the container's idea of its size.
            let (w, h) = jpeg_dimensions(&jpeg).unwrap_or((thumb.width, thumb.height));
            (jpeg, w, h)
        }
        MemImageKind::Bitmap => encode_bitmap(&image)?,
        MemImageKind::Other => {
            return Err(Error::NoPreview {
                path: path.to_owned(),
            });
        }
    };
    Ok(Preview {
        jpeg,
        width,
        height,
        orientation,
    })
}

/// The largest JPEG preview, or failing that the largest of any kind.
fn best_thumbnail(thumbs: &[ThumbInfo]) -> Option<ThumbInfo> {
    let area = |t: &&ThumbInfo| u64::from(t.width) * u64::from(t.height);
    thumbs
        .iter()
        .filter(|t| t.is_jpeg)
        .max_by_key(area)
        .or_else(|| thumbs.iter().max_by_key(area))
        .copied()
}

fn encode_bitmap(image: &MemImage) -> Result<(Vec<u8>, u32, u32)> {
    let (width, height) = (image.width(), image.height());
    let (w16, h16) = (
        u16::try_from(width).map_err(|_| Error::TooLarge { width, height })?,
        u16::try_from(height).map_err(|_| Error::TooLarge { width, height })?,
    );
    let pixels = width as usize * height as usize;
    let data = image.data();
    let rgb: Vec<u8> = match (image.colors(), image.bits()) {
        (3, 8) if data.len() >= pixels * 3 => data[..pixels * 3].to_vec(),
        // 16-bit samples are native-endian; keep the high byte.
        (3, 16) if data.len() >= pixels * 6 => data[..pixels * 6]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&s| (u16::from_ne_bytes(s) >> 8) as u8)
            .collect(),
        (1, 8) if data.len() >= pixels => data[..pixels].iter().flat_map(|&g| [g; 3]).collect(),
        (colors, bits) => {
            return Err(Error::Encode(format!(
                "unsupported {colors}-channel {bits}-bit preview bitmap of {} bytes",
                data.len()
            )));
        }
    };
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, BITMAP_JPEG_QUALITY)
        .encode(&rgb, w16, h16, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| Error::Encode(e.to_string()))?;
    Ok((jpeg, width, height))
}

/// Reads the pixel size from a JPEG's first start-of-frame marker.
pub fn jpeg_dimensions(jpeg: &[u8]) -> Option<(u32, u32)> {
    if jpeg.get(..2)? != [0xff, 0xd8] {
        return None;
    }
    let mut i = 2;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xff {
            return None;
        }
        let marker = jpeg[i + 1];
        match marker {
            // Fill bytes and standalone markers carry no length.
            0xff => {
                i += 1;
                continue;
            }
            0x01 | 0xd0..=0xd8 => {
                i += 2;
                continue;
            }
            0xd9 | 0xda => return None,
            _ => {}
        }
        let len = usize::from(u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]));
        // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc).
        if matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            let sof = jpeg.get(i + 4..i + 9)?;
            let height = u32::from(u16::from_be_bytes([sof[1], sof[2]]));
            let width = u32::from(u16::from_be_bytes([sof[3], sof[4]]));
            return Some((width, height));
        }
        i += 2 + len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::fixtures;

    fn decode(jpeg: &[u8]) -> (usize, usize, Vec<u8>) {
        let mut decoder = zune_jpeg::JpegDecoder::new(std::io::Cursor::new(jpeg));
        let pixels = decoder.decode().expect("valid JPEG");
        let info = decoder.info().expect("decoded info");
        (info.width as usize, info.height as usize, pixels)
    }

    #[test]
    fn extracts_a_valid_full_size_jpeg_from_every_fixture() {
        for path in fixtures() {
            let preview = extract_preview(&path).unwrap();
            assert_eq!(preview.jpeg[..2], [0xff, 0xd8], "SOI");
            assert_eq!(preview.jpeg[preview.jpeg.len() - 2..], [0xff, 0xd9], "EOI");
            // Z bodies embed a (nearly) full-resolution preview.
            assert!(
                preview.width >= 4000,
                "{}x{}",
                preview.width,
                preview.height
            );
            assert!(preview.height >= 3000);
            let (w, h, pixels) = decode(&preview.jpeg);
            assert_eq!((w as u32, h as u32), (preview.width, preview.height));
            assert_eq!(pixels.len(), w * h * 3);
            let mean = pixels.iter().map(|&v| f64::from(v)).sum::<f64>() / pixels.len() as f64;
            assert!(mean > 5.0 && mean < 250.0, "implausible mean {mean}");
            assert!((1..=8).contains(&preview.orientation));
            println!(
                "{}: {}x{} {} bytes",
                path.display(),
                w,
                h,
                preview.jpeg.len()
            );
        }
    }

    #[test]
    fn missing_file_is_reported_as_an_error() {
        assert!(extract_preview(Path::new("/nope.nef")).is_err());
    }

    #[test]
    fn picks_the_largest_jpeg_over_a_larger_bitmap() {
        let t = |index, w, h, is_jpeg| ThumbInfo {
            index,
            width: w,
            height: h,
            is_jpeg,
        };
        let thumbs = [
            t(0, 160, 120, false),
            t(1, 6048, 4024, true),
            t(2, 1620, 1080, true),
            t(3, 8000, 6000, false),
        ];
        assert_eq!(best_thumbnail(&thumbs).unwrap().index, 1);
        assert_eq!(best_thumbnail(&thumbs[..1]).unwrap().index, 0);
        assert!(best_thumbnail(&[]).is_none());
    }

    #[test]
    fn jpeg_dimensions_reads_the_frame_header() {
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 80)
            .encode(&[0u8; 37 * 21 * 3], 37, 21, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        assert_eq!(jpeg_dimensions(&jpeg), Some((37, 21)));
        assert_eq!(jpeg_dimensions(b"not a jpeg"), None);
    }

    #[test]
    fn bitmaps_are_encoded_to_decodable_jpegs() {
        // Exercise the encoder path with a synthetic gradient; real bitmap
        // previews only come from older or exotic cameras.
        let (w, h) = (64usize, 48usize);
        let rgb: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % w * 4) as u8, (i / w * 5) as u8, 128])
            .collect();
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, BITMAP_JPEG_QUALITY)
            .encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        let (dw, dh, _) = decode(&jpeg);
        assert_eq!((dw, dh), (w, h));
    }
}
