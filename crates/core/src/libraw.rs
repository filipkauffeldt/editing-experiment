//! Safe, RAII wrapper over the LibRaw C API.
//!
//! One [`LibRaw`] owns one `libraw_data_t`. Handles are independent, so
//! different threads may each use their own; a single handle is not
//! thread-safe (hence `Send` but not `Sync`).

use crate::error::{Error, Result};
use crate::ffi;
use std::ffi::{CStr, c_char, c_int};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;

/// An open raw file.
pub struct LibRaw {
    ptr: NonNull<ffi::LibRawData>,
    path: PathBuf,
    /// `Send` (moved to a worker thread) but not `Sync`.
    _not_sync: PhantomData<std::cell::Cell<()>>,
}

// SAFETY: a libraw_data_t has no thread affinity; it is only unsafe to use it
// from two threads at once, which `!Sync` plus `&mut self` for mutation prevent.
unsafe impl Send for LibRaw {}

/// Version string of the vendored LibRaw, for diagnostics and tests.
pub fn libraw_version() -> String {
    // SAFETY: returns a pointer to a static NUL-terminated string.
    unsafe { cstr(ffi::libraw_version()) }
}

/// Copies a possibly-null C string, trimming whitespace LibRaw leaves in tags.
///
/// # Safety
/// `ptr` must be null or point to a NUL-terminated string.
unsafe fn cstr(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // SAFETY: guaranteed by the caller.
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .trim()
        .to_owned()
}

fn error_message(code: c_int) -> String {
    // SAFETY: libraw_strerror returns a static string for any code.
    unsafe { cstr(ffi::libraw_strerror(code)) }
}

impl LibRaw {
    /// Opens `path` and parses its metadata (no pixel data is read yet).
    pub fn open(path: &Path) -> Result<Self> {
        // SAFETY: plain allocation; returns null on failure.
        let raw = unsafe { ffi::libraw_init(ffi::LIBRAW_OPTIONS_NO_DATAERR_CALLBACK) };
        let ptr = NonNull::new(raw).ok_or_else(|| Error::LibRaw {
            operation: "initialise LibRaw",
            path: path.to_owned(),
            code: ffi::LIBRAW_UNSUFFICIENT_MEMORY,
            message: "out of memory".to_owned(),
        })?;
        // From here on `Drop` frees the handle on every error path.
        let lr = LibRaw {
            ptr,
            path: path.to_owned(),
            _not_sync: PhantomData,
        };
        let code = lr.open_file(path)?;
        match code {
            ffi::LIBRAW_SUCCESS => {}
            ffi::LIBRAW_FILE_UNSUPPORTED => {
                return Err(Error::UnsupportedFile {
                    path: path.to_owned(),
                    message: error_message(code),
                });
            }
            ffi::LIBRAW_IO_ERROR => {
                return Err(Error::Io {
                    path: path.to_owned(),
                    message: error_message(code),
                });
            }
            _ => return Err(lr.error("open file", code)),
        }
        Ok(lr)
    }

    #[cfg(not(windows))]
    fn open_file(&self, path: &Path) -> Result<c_int> {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| Error::InvalidArgument("path contains a NUL byte".to_owned()))?;
        // SAFETY: valid handle and NUL-terminated path.
        Ok(unsafe { ffi::libraw_open_file(self.ptr.as_ptr(), c_path.as_ptr()) })
    }

    #[cfg(windows)]
    fn open_file(&self, path: &Path) -> Result<c_int> {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: valid handle and NUL-terminated UTF-16 path.
        Ok(unsafe { ffi::libraw_open_wfile(self.ptr.as_ptr(), wide.as_ptr()) })
    }

    fn error(&self, operation: &'static str, code: c_int) -> Error {
        Error::LibRaw {
            operation,
            path: self.path.clone(),
            code,
            message: error_message(code),
        }
    }

    /// Converts a LibRaw status code into a typed error.
    fn check(&self, operation: &'static str, code: c_int) -> Result<()> {
        if code == ffi::LIBRAW_SUCCESS {
            Ok(())
        } else {
            Err(self.error(operation, code))
        }
    }

    // --- identification ---------------------------------------------------

    pub fn make(&self) -> String {
        // SAFETY (all getters below): valid handle; shim returns pointers into it.
        unsafe { cstr(ffi::ee_make(self.ptr.as_ptr())) }
    }
    pub fn model(&self) -> String {
        unsafe { cstr(ffi::ee_model(self.ptr.as_ptr())) }
    }
    pub fn normalized_make(&self) -> String {
        unsafe { cstr(ffi::ee_normalized_make(self.ptr.as_ptr())) }
    }
    pub fn normalized_model(&self) -> String {
        unsafe { cstr(ffi::ee_normalized_model(self.ptr.as_ptr())) }
    }
    pub fn lens_name(&self) -> String {
        unsafe { cstr(ffi::ee_lens_name(self.ptr.as_ptr())) }
    }
    pub fn makernotes_lens_name(&self) -> String {
        unsafe { cstr(ffi::ee_makernotes_lens_name(self.ptr.as_ptr())) }
    }
    /// Focal range of the lens as reported by the camera; (0, 0) when unknown.
    pub fn lens_focal_range(&self) -> (f32, f32) {
        unsafe {
            (
                ffi::ee_min_focal(self.ptr.as_ptr()),
                ffi::ee_max_focal(self.ptr.as_ptr()),
            )
        }
    }
    pub fn body_serial(&self) -> String {
        unsafe { cstr(ffi::ee_body_serial(self.ptr.as_ptr())) }
    }
    pub fn internal_body_serial(&self) -> String {
        unsafe { cstr(ffi::ee_internal_body_serial(self.ptr.as_ptr())) }
    }

    // --- exposure ---------------------------------------------------------

    pub fn iso(&self) -> f32 {
        unsafe { ffi::ee_iso(self.ptr.as_ptr()) }
    }
    pub fn shutter(&self) -> f32 {
        unsafe { ffi::ee_shutter(self.ptr.as_ptr()) }
    }
    pub fn aperture(&self) -> f32 {
        unsafe { ffi::ee_aperture(self.ptr.as_ptr()) }
    }
    pub fn focal_length(&self) -> f32 {
        unsafe { ffi::ee_focal_length(self.ptr.as_ptr()) }
    }
    /// Camera wall-clock capture time as seconds since the epoch, interpreted
    /// as UTC (EXIF has no time zone). 0 when unknown.
    pub fn timestamp(&self) -> i64 {
        unsafe { ffi::ee_timestamp(self.ptr.as_ptr()) }
    }

    // --- geometry ---------------------------------------------------------

    pub fn raw_size(&self) -> (u32, u32) {
        let (w, h) = unsafe {
            (
                ffi::ee_raw_width(self.ptr.as_ptr()),
                ffi::ee_raw_height(self.ptr.as_ptr()),
            )
        };
        (w.max(0) as u32, h.max(0) as u32)
    }

    /// Active image area before orientation.
    pub fn image_size(&self) -> (u32, u32) {
        let (w, h) = unsafe {
            (
                ffi::ee_image_width(self.ptr.as_ptr()),
                ffi::ee_image_height(self.ptr.as_ptr()),
            )
        };
        (w.max(0) as u32, h.max(0) as u32)
    }

    /// Orientation as an EXIF value 1..=8, converted from LibRaw's dcraw flip
    /// code.
    pub fn orientation(&self) -> u8 {
        exif_orientation_from_flip(unsafe { ffi::ee_flip(self.ptr.as_ptr()) })
    }

    // --- colour -----------------------------------------------------------

    /// Camera white balance multipliers (R, G1, B, G2); G2 is 0 on RGB sensors.
    pub fn cam_mul(&self) -> [f32; 4] {
        std::array::from_fn(|i| unsafe { ffi::ee_cam_mul(self.ptr.as_ptr(), i as c_int) })
    }
    /// Row-major 3x3 camera-to-sRGB matrix (`rgb_cam`).
    pub fn rgb_cam(&self) -> [f32; 9] {
        std::array::from_fn(|i| unsafe {
            ffi::ee_rgb_cam(self.ptr.as_ptr(), (i / 3) as c_int, (i % 3) as c_int)
        })
    }
    /// Row-major 3x3 XYZ-to-camera matrix (the 3x3 part of `cam_xyz`).
    pub fn cam_xyz(&self) -> [f32; 9] {
        std::array::from_fn(|i| unsafe {
            ffi::ee_cam_xyz(self.ptr.as_ptr(), (i / 3) as c_int, (i % 3) as c_int)
        })
    }
    pub fn colors(&self) -> u32 {
        unsafe { ffi::ee_colors(self.ptr.as_ptr()) }.max(0) as u32
    }

    // --- pipeline ---------------------------------------------------------

    /// Computes the output sizes without reading pixel data.
    pub fn adjust_sizes_info_only(&mut self) -> Result<()> {
        let code = unsafe { ffi::libraw_adjust_sizes_info_only(self.ptr.as_ptr()) };
        self.check("compute image sizes", code)
    }

    /// Reads and decompresses the raw sensor data.
    pub fn unpack(&mut self) -> Result<()> {
        let code = unsafe { ffi::libraw_unpack(self.ptr.as_ptr()) };
        self.check("unpack raw data", code)
    }

    /// Configures the linear camera-RGB decode (see `ee_configure_linear_decode`).
    pub fn configure_linear_decode(&mut self, half_size: bool) {
        unsafe { ffi::ee_configure_linear_decode(self.ptr.as_ptr(), half_size as c_int) }
    }

    /// Black subtraction, scaling and demosaicing into the internal buffer.
    pub fn process(&mut self) -> Result<()> {
        let code = unsafe { ffi::libraw_dcraw_process(self.ptr.as_ptr()) };
        self.check("develop raw data", code)
    }

    /// Copies the processed image out of LibRaw.
    pub fn make_mem_image(&mut self) -> Result<MemImage> {
        let mut code: c_int = 0;
        let ptr = unsafe { ffi::libraw_dcraw_make_mem_image(self.ptr.as_ptr(), &mut code) };
        self.wrap_image("copy developed image", ptr, code)
    }

    // --- embedded previews ---------------------------------------------------

    /// `(width, height, is_jpeg)` of every embedded preview LibRaw found.
    pub fn thumbnails(&self) -> Vec<ThumbInfo> {
        let count = unsafe { ffi::ee_thumb_count(self.ptr.as_ptr()) }.max(0);
        (0..count)
            .map(|i| unsafe {
                ThumbInfo {
                    index: i as u32,
                    width: ffi::ee_thumb_item_width(self.ptr.as_ptr(), i).max(0) as u32,
                    height: ffi::ee_thumb_item_height(self.ptr.as_ptr(), i).max(0) as u32,
                    is_jpeg: ffi::ee_thumb_item_is_jpeg(self.ptr.as_ptr(), i) != 0,
                }
            })
            .collect()
    }

    /// Reads embedded preview `index` (from [`LibRaw::thumbnails`]).
    pub fn unpack_thumb(&mut self, index: u32) -> Result<()> {
        let code = unsafe { ffi::libraw_unpack_thumb_ex(self.ptr.as_ptr(), index as c_int) };
        match code {
            ffi::LIBRAW_NO_THUMBNAIL | ffi::LIBRAW_UNSUPPORTED_THUMBNAIL => Err(Error::NoPreview {
                path: self.path.clone(),
            }),
            _ => self.check("unpack preview", code),
        }
    }

    /// The unpacked preview as JPEG bytes or an 8/16-bit bitmap.
    pub fn make_mem_thumb(&mut self) -> Result<MemImage> {
        let mut code: c_int = 0;
        let ptr = unsafe { ffi::libraw_dcraw_make_mem_thumb(self.ptr.as_ptr(), &mut code) };
        self.wrap_image("read preview", ptr, code)
    }

    fn wrap_image(
        &self,
        operation: &'static str,
        ptr: *mut ffi::ProcessedImage,
        code: c_int,
    ) -> Result<MemImage> {
        match NonNull::new(ptr) {
            Some(ptr) if code == ffi::LIBRAW_SUCCESS => Ok(MemImage { ptr }),
            // A non-null pointer with an error code must still be freed.
            Some(ptr) => {
                drop(MemImage { ptr });
                Err(self.error(operation, code))
            }
            None => Err(self.error(operation, code)),
        }
    }
}

impl Drop for LibRaw {
    fn drop(&mut self) {
        // SAFETY: the handle came from libraw_init and is closed exactly once.
        unsafe { ffi::libraw_close(self.ptr.as_ptr()) }
    }
}

/// An embedded preview as listed by LibRaw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThumbInfo {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub is_jpeg: bool,
}

/// What a [`MemImage`] contains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemImageKind {
    Jpeg,
    Bitmap,
    Other,
}

/// A `libraw_processed_image_t`; freed on drop. Independent of the handle that
/// produced it.
pub struct MemImage {
    ptr: NonNull<ffi::ProcessedImage>,
}

// SAFETY: plain malloc'd memory owned by this value.
unsafe impl Send for MemImage {}

impl MemImage {
    pub fn kind(&self) -> MemImageKind {
        let t = unsafe { ffi::ee_image_type(self.ptr.as_ptr()) };
        if t == unsafe { ffi::ee_image_type_jpeg() } {
            MemImageKind::Jpeg
        } else if t == unsafe { ffi::ee_image_type_bitmap() } {
            MemImageKind::Bitmap
        } else {
            MemImageKind::Other
        }
    }
    pub fn width(&self) -> u32 {
        unsafe { ffi::ee_image_out_width(self.ptr.as_ptr()) }.max(0) as u32
    }
    pub fn height(&self) -> u32 {
        unsafe { ffi::ee_image_out_height(self.ptr.as_ptr()) }.max(0) as u32
    }
    pub fn colors(&self) -> u32 {
        unsafe { ffi::ee_image_out_colors(self.ptr.as_ptr()) }.max(0) as u32
    }
    pub fn bits(&self) -> u32 {
        unsafe { ffi::ee_image_out_bits(self.ptr.as_ptr()) }.max(0) as u32
    }
    /// The pixel bytes (interleaved, native endian for 16-bit) or JPEG stream.
    pub fn data(&self) -> &[u8] {
        let len = unsafe { ffi::ee_image_out_size(self.ptr.as_ptr()) } as usize;
        let data = unsafe { ffi::ee_image_out_data(self.ptr.as_ptr()) };
        if data.is_null() || len == 0 {
            return &[];
        }
        // SAFETY: LibRaw allocated `data_size` bytes after the header, alive
        // until `libraw_dcraw_clear_mem` in Drop.
        unsafe { std::slice::from_raw_parts(data, len) }
    }
}

impl Drop for MemImage {
    fn drop(&mut self) {
        // SAFETY: allocated by LibRaw and freed exactly once.
        unsafe { ffi::libraw_dcraw_clear_mem(self.ptr.as_ptr()) }
    }
}

/// Converts a LibRaw/dcraw flip code to an EXIF orientation (1..=8).
///
/// dcraw stores orientation as bit flags: 1 = flip horizontally, 2 = flip
/// vertically, 4 = transpose (applied first).
pub fn exif_orientation_from_flip(flip: i32) -> u8 {
    match flip & 7 {
        0 => 1,
        1 => 2,
        2 => 4,
        3 => 3,
        4 => 5,
        5 => 8,
        6 => 6,
        _ => 7,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendored_version_is_linked() {
        assert!(
            libraw_version().starts_with("0.22.3"),
            "{}",
            libraw_version()
        );
    }

    #[test]
    fn flip_codes_map_to_exif_orientations() {
        // dcraw: 3 = 180 degrees, 6 = 90 cw, 5 = 90 ccw.
        assert_eq!(exif_orientation_from_flip(0), 1);
        assert_eq!(exif_orientation_from_flip(3), 3);
        assert_eq!(exif_orientation_from_flip(6), 6);
        assert_eq!(exif_orientation_from_flip(5), 8);
    }

    #[test]
    fn opening_a_missing_file_is_an_io_error() {
        let err = LibRaw::open(Path::new("/definitely/not/here.nef"))
            .err()
            .expect("must fail");
        assert!(matches!(err, Error::Io { .. }), "{err}");
    }

    #[test]
    fn opening_a_non_raw_file_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.nef");
        // LibRaw reports files shorter than a header as I/O errors, so use enough
        // bytes to get past that.
        std::fs::write(&path, vec![0x5a_u8; 64 * 1024]).unwrap();
        let err = LibRaw::open(&path).err().expect("must fail");
        assert!(matches!(err, Error::UnsupportedFile { .. }), "{err}");
    }
}
