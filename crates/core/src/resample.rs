//! Orients and area-averages 16-bit RGB into RGBA float samples.
//!
//! One pass does everything the decode needs after LibRaw: display
//! orientation, an exact box (area-average) downscale, scaling to 0..=1 and
//! conversion to the output sample type. Box filtering in linear light is the
//! physically right way to shrink, and it is cheap.

use crate::orient::OrientMap;

/// Sample type of the RGBA output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleType {
    F16,
    F32,
}

impl SampleType {
    pub fn bytes_per_sample(self) -> usize {
        match self {
            SampleType::F16 => 2,
            SampleType::F32 => 4,
        }
    }
}

/// Interleaved RGB, 16 bits per sample, native endian, row-major.
#[derive(Clone, Copy)]
pub struct Rgb16<'a> {
    pub data: &'a [u8],
    pub width: u32,
    pub height: u32,
}

/// Value of full scale in the 16-bit source (LibRaw maps the white level to it).
const FULL_SCALE: f32 = 65535.0;

/// Source pixels contributing to each output index along one axis.
struct Axis {
    /// `taps[offsets[i]..offsets[i + 1]]` belong to output index `i`.
    offsets: Vec<usize>,
    /// `(source index, weight)`; weights of one output index sum to 1.
    taps: Vec<(u32, f32)>,
}

impl Axis {
    fn new(src_len: u32, out_len: u32) -> Self {
        let scale = f64::from(src_len) / f64::from(out_len);
        let mut offsets = Vec::with_capacity(out_len as usize + 1);
        let mut taps = Vec::new();
        for o in 0..out_len {
            offsets.push(taps.len());
            let lo = f64::from(o) * scale;
            let hi = (f64::from(o) + 1.0) * scale;
            let first = lo.floor() as u32;
            let last = (hi.ceil() as u32).min(src_len);
            for i in first..last {
                let overlap = hi.min(f64::from(i) + 1.0) - lo.max(f64::from(i));
                if overlap > 1e-9 {
                    taps.push((i, (overlap / scale) as f32));
                }
            }
        }
        offsets.push(taps.len());
        Axis { offsets, taps }
    }

    fn taps_of(&self, i: usize) -> &[(u32, f32)] {
        &self.taps[self.offsets[i]..self.offsets[i + 1]]
    }
}

/// Orients `src` to display orientation and resamples it to `out_w` x `out_h`
/// (the display size when no downscale is wanted). Returns RGBA, alpha 1.
///
/// `out_w`/`out_h` must be non-zero and no larger than the oriented size.
pub fn resample_rgba(
    src: Rgb16,
    orientation: u8,
    out_w: u32,
    out_h: u32,
    sample: SampleType,
) -> Vec<u8> {
    assert!(out_w > 0 && out_h > 0, "empty output");
    assert!(
        src.data.len() >= src.width as usize * src.height as usize * 6,
        "source buffer too small"
    );
    let map = OrientMap::new(src.width, src.height, orientation);
    assert!(
        out_w <= map.width && out_h <= map.height,
        "upscaling is not supported"
    );

    let x_axis = Axis::new(map.width, out_w);
    let y_axis = Axis::new(map.height, out_h);
    let row_bytes = out_w as usize * 4 * sample.bytes_per_sample();
    let mut out = vec![0u8; row_bytes * out_h as usize];

    let threads = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(out_h as usize);
    let rows_per_chunk = (out_h as usize).div_ceil(threads);
    std::thread::scope(|scope| {
        for (chunk_index, chunk) in out.chunks_mut(rows_per_chunk * row_bytes).enumerate() {
            let (x_axis, y_axis, map) = (&x_axis, &y_axis, &map);
            scope.spawn(move || {
                let mut acc = vec![0f32; out_w as usize * 3];
                for (row_in_chunk, row) in chunk.chunks_exact_mut(row_bytes).enumerate() {
                    let oy = chunk_index * rows_per_chunk + row_in_chunk;
                    accumulate_row(src, map, x_axis, y_axis.taps_of(oy), &mut acc);
                    write_row(&acc, row, sample);
                }
            });
        }
    });
    out
}

/// Weighted sum over the source rows `y_taps` into `acc` (RGB per output x).
fn accumulate_row(
    src: Rgb16,
    map: &OrientMap,
    x_axis: &Axis,
    y_taps: &[(u32, f32)],
    acc: &mut [f32],
) {
    acc.fill(0.0);
    let sample = |pixel: usize, channel: usize| -> f32 {
        let at = (pixel * 3 + channel) * 2;
        f32::from(u16::from_ne_bytes([src.data[at], src.data[at + 1]]))
    };
    for &(sy, wy) in y_taps {
        for (ox, out) in acc.as_chunks_mut::<3>().0.iter_mut().enumerate() {
            let (mut r, mut g, mut b) = (0f32, 0f32, 0f32);
            for &(sx, wx) in x_axis.taps_of(ox) {
                let pixel = map.index(sx, sy);
                r += wx * sample(pixel, 0);
                g += wx * sample(pixel, 1);
                b += wx * sample(pixel, 2);
            }
            out[0] += wy * r;
            out[1] += wy * g;
            out[2] += wy * b;
        }
    }
}

fn write_row(acc: &[f32], row: &mut [u8], sample: SampleType) {
    let scale = 1.0 / FULL_SCALE;
    match sample {
        SampleType::F32 => {
            for (rgb, px) in acc
                .as_chunks::<3>()
                .0
                .iter()
                .zip(row.as_chunks_mut::<16>().0)
            {
                for (c, value) in [rgb[0], rgb[1], rgb[2], FULL_SCALE].into_iter().enumerate() {
                    px[c * 4..c * 4 + 4].copy_from_slice(&(value * scale).to_le_bytes());
                }
            }
        }
        SampleType::F16 => {
            for (rgb, px) in acc
                .as_chunks::<3>()
                .0
                .iter()
                .zip(row.as_chunks_mut::<8>().0)
            {
                for (c, value) in [rgb[0], rgb[1], rgb[2], FULL_SCALE].into_iter().enumerate() {
                    px[c * 2..c * 2 + 2]
                        .copy_from_slice(&half::f16::from_f32(value * scale).to_le_bytes());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an RGB16 image whose pixel `i` has R=values[i], G=2*R, B=3*R.
    fn image(width: u32, height: u32, values: &[u16]) -> Vec<u8> {
        assert_eq!(values.len(), (width * height) as usize);
        values
            .iter()
            .flat_map(|&v| [v, v * 2, v * 3])
            .flat_map(u16::to_ne_bytes)
            .collect()
    }

    fn f32s(bytes: &[u8]) -> Vec<f32> {
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&c| f32::from_le_bytes(c))
            .collect()
    }

    fn reds(rgba: &[f32]) -> Vec<f32> {
        rgba.as_chunks::<4>()
            .0
            .iter()
            .map(|p| p[0] * FULL_SCALE)
            .collect()
    }

    #[test]
    fn identity_keeps_values_and_sets_alpha_to_one() {
        let data = image(2, 2, &[100, 200, 300, 400]);
        let src = Rgb16 {
            data: &data,
            width: 2,
            height: 2,
        };
        let out = f32s(&resample_rgba(src, 1, 2, 2, SampleType::F32));
        assert_eq!(out.len(), 16);
        for (px, expected) in out
            .as_chunks::<4>()
            .0
            .iter()
            .zip([100.0, 200.0, 300.0, 400.0])
        {
            assert!((px[0] * FULL_SCALE - expected).abs() < 0.01);
            assert!((px[1] * FULL_SCALE - expected * 2.0).abs() < 0.02);
            assert!((px[2] * FULL_SCALE - expected * 3.0).abs() < 0.03);
            assert_eq!(px[3], 1.0);
        }
    }

    #[test]
    fn box_filter_averages_exactly() {
        // 4x2 -> 2x1: each output pixel is the mean of a 2x2 block.
        let data = image(4, 2, &[0, 100, 200, 300, 400, 500, 600, 700]);
        let src = Rgb16 {
            data: &data,
            width: 4,
            height: 2,
        };
        let out = f32s(&resample_rgba(src, 1, 2, 1, SampleType::F32));
        let r = reds(&out);
        assert!((r[0] - 250.0).abs() < 0.05, "{r:?}");
        assert!((r[1] - 450.0).abs() < 0.05, "{r:?}");
    }

    #[test]
    fn fractional_scales_conserve_the_mean() {
        // 5 -> 3 needs fractional pixel weights; a constant must stay constant
        // and the overall mean must not drift.
        let values: Vec<u16> = (0..5 * 5).map(|i| (i * 40) as u16).collect();
        let data = image(5, 5, &values);
        let src = Rgb16 {
            data: &data,
            width: 5,
            height: 5,
        };
        let out = f32s(&resample_rgba(src, 1, 3, 3, SampleType::F32));
        let mean_in = values.iter().map(|&v| f32::from(v)).sum::<f32>() / 25.0;
        let r = reds(&out);
        let mean_out = r.iter().sum::<f32>() / 9.0;
        assert!((mean_in - mean_out).abs() < 0.5, "{mean_in} vs {mean_out}");
    }

    #[test]
    fn applies_orientation_while_resampling() {
        // 3x2 source rotated 90 degrees cw (orientation 6) is 2x3.
        let data = image(3, 2, &[10, 20, 30, 40, 50, 60]);
        let src = Rgb16 {
            data: &data,
            width: 3,
            height: 2,
        };
        let out = f32s(&resample_rgba(src, 6, 2, 3, SampleType::F32));
        let r: Vec<f32> = reds(&out).iter().map(|v| v.round()).collect();
        assert_eq!(r, [40.0, 10.0, 50.0, 20.0, 60.0, 30.0]);
    }

    #[test]
    fn half_floats_match_f32() {
        let data = image(2, 1, &[16384, 21845]);
        let src = Rgb16 {
            data: &data,
            width: 2,
            height: 1,
        };
        let out = resample_rgba(src, 1, 2, 1, SampleType::F16);
        assert_eq!(out.len(), 2 * 4 * 2);
        let first_red = half::f16::from_le_bytes([out[0], out[1]]).to_f32();
        assert!((first_red - 16384.0 / 65535.0).abs() < 1e-3);
        let alpha = half::f16::from_le_bytes([out[6], out[7]]).to_f32();
        assert_eq!(alpha, 1.0);
    }
}
