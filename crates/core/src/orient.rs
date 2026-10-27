//! EXIF orientation helpers shared by info, preview and decode.

/// Display size of a `width` x `height` image once `orientation` (EXIF 1..=8)
/// has been applied. Orientations 5..=8 swap the axes.
pub fn oriented_size(width: u32, height: u32, orientation: u8) -> (u32, u32) {
    if orientation >= 5 {
        (height, width)
    } else {
        (width, height)
    }
}

/// Maps display coordinates to source pixel indexes for one EXIF orientation:
/// `index(x, y) = base + x * step_x + y * step_y` (signed, in pixels).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrientMap {
    pub base: isize,
    pub step_x: isize,
    pub step_y: isize,
    /// Display size.
    pub width: u32,
    pub height: u32,
}

impl OrientMap {
    /// For a source image of `src_w` x `src_h` pixels in row-major order.
    /// Unknown orientation values are treated as 1 (no change).
    pub fn new(src_w: u32, src_h: u32, orientation: u8) -> Self {
        let (w, h) = (src_w as isize, src_h as isize);
        let (base, step_x, step_y) = match orientation {
            2 => (w - 1, -1, w),
            3 => ((h - 1) * w + w - 1, -1, -w),
            4 => ((h - 1) * w, 1, -w),
            5 => (0, w, 1),
            6 => ((h - 1) * w, -w, 1),
            7 => ((h - 1) * w + w - 1, -w, -1),
            8 => (w - 1, w, -1),
            _ => (0, 1, w),
        };
        let (width, height) = oriented_size(src_w, src_h, orientation);
        OrientMap {
            base,
            step_x,
            step_y,
            width,
            height,
        }
    }

    /// Source pixel index for display pixel `(x, y)`.
    #[inline]
    pub fn index(&self, x: u32, y: u32) -> usize {
        (self.base + x as isize * self.step_x + y as isize * self.step_y) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 3x2 image:
    ///   a b c
    ///   d e f
    const SRC: [char; 6] = ['a', 'b', 'c', 'd', 'e', 'f'];

    fn render(orientation: u8) -> Vec<String> {
        let map = OrientMap::new(3, 2, orientation);
        (0..map.height)
            .map(|y| {
                (0..map.width)
                    .map(|x| SRC[map.index(x, y)])
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn all_eight_orientations_match_the_exif_definition() {
        assert_eq!(render(1), ["abc", "def"]);
        assert_eq!(render(2), ["cba", "fed"]); // mirror horizontal
        assert_eq!(render(3), ["fed", "cba"]); // rotate 180
        assert_eq!(render(4), ["def", "abc"]); // mirror vertical
        assert_eq!(render(5), ["ad", "be", "cf"]); // transpose
        assert_eq!(render(6), ["da", "eb", "fc"]); // rotate 90 cw
        assert_eq!(render(7), ["fc", "eb", "da"]); // transverse
        assert_eq!(render(8), ["cf", "be", "ad"]); // rotate 90 ccw
    }

    #[test]
    fn axes_swap_for_rotated_orientations() {
        assert_eq!(oriented_size(6048, 4032, 1), (6048, 4032));
        assert_eq!(oriented_size(6048, 4032, 6), (4032, 6048));
        assert_eq!(oriented_size(6048, 4032, 8), (4032, 6048));
    }
}
