//! Raw FFI declarations for LibRaw's C API and our accessor shim
//! (`shim/ee_libraw.c`). Hand-written on purpose: the surface is small and
//! `libraw_data_t` is never mirrored, so LibRaw upgrades cannot silently shift
//! struct offsets under us.
//!
//! Everything here is `unsafe` to call; use [`crate::libraw`] instead.

use std::ffi::{c_char, c_float, c_int, c_longlong, c_uchar, c_uint};

/// Opaque `libraw_data_t`.
#[repr(C)]
pub struct LibRawData {
    _private: [u8; 0],
}

/// Opaque `libraw_processed_image_t`.
#[repr(C)]
pub struct ProcessedImage {
    _private: [u8; 0],
}

/// `LIBRAW_OPTIONS_NO_DATAERR_CALLBACK`: do not print data errors to stderr.
pub const LIBRAW_OPTIONS_NO_DATAERR_CALLBACK: c_uint = 1 << 1;

pub const LIBRAW_SUCCESS: c_int = 0;
pub const LIBRAW_FILE_UNSUPPORTED: c_int = -2;
pub const LIBRAW_NO_THUMBNAIL: c_int = -5;
pub const LIBRAW_UNSUPPORTED_THUMBNAIL: c_int = -6;
pub const LIBRAW_UNSUFFICIENT_MEMORY: c_int = -100007;
pub const LIBRAW_DATA_ERROR: c_int = -100008;
pub const LIBRAW_IO_ERROR: c_int = -100009;
pub const LIBRAW_TOO_BIG: c_int = -100012;

/// LibRaw's `LIBRAW_FATAL_ERROR(ec)`: the handle is unusable after these.
pub fn is_fatal(code: c_int) -> bool {
    code < -100000
}

unsafe extern "C" {
    // --- LibRaw C API (libraw.h) ---
    pub fn libraw_init(flags: c_uint) -> *mut LibRawData;
    pub fn libraw_close(lr: *mut LibRawData);
    pub fn libraw_strerror(code: c_int) -> *const c_char;
    pub fn libraw_version() -> *const c_char;
    #[cfg(not(windows))]
    pub fn libraw_open_file(lr: *mut LibRawData, path: *const c_char) -> c_int;
    #[cfg(windows)]
    pub fn libraw_open_wfile(lr: *mut LibRawData, path: *const u16) -> c_int;
    pub fn libraw_adjust_sizes_info_only(lr: *mut LibRawData) -> c_int;
    pub fn libraw_unpack(lr: *mut LibRawData) -> c_int;
    pub fn libraw_unpack_thumb_ex(lr: *mut LibRawData, index: c_int) -> c_int;
    pub fn libraw_dcraw_process(lr: *mut LibRawData) -> c_int;
    pub fn libraw_dcraw_make_mem_image(
        lr: *mut LibRawData,
        errc: *mut c_int,
    ) -> *mut ProcessedImage;
    pub fn libraw_dcraw_make_mem_thumb(
        lr: *mut LibRawData,
        errc: *mut c_int,
    ) -> *mut ProcessedImage;
    pub fn libraw_dcraw_clear_mem(image: *mut ProcessedImage);

    // --- shim (shim/ee_libraw.c) ---
    pub fn ee_configure_linear_decode(lr: *mut LibRawData, half_size: c_int);

    pub fn ee_make(lr: *mut LibRawData) -> *const c_char;
    pub fn ee_model(lr: *mut LibRawData) -> *const c_char;
    pub fn ee_normalized_make(lr: *mut LibRawData) -> *const c_char;
    pub fn ee_normalized_model(lr: *mut LibRawData) -> *const c_char;
    pub fn ee_lens_name(lr: *mut LibRawData) -> *const c_char;
    pub fn ee_makernotes_lens_name(lr: *mut LibRawData) -> *const c_char;
    pub fn ee_min_focal(lr: *mut LibRawData) -> c_float;
    pub fn ee_max_focal(lr: *mut LibRawData) -> c_float;
    pub fn ee_body_serial(lr: *mut LibRawData) -> *const c_char;
    pub fn ee_internal_body_serial(lr: *mut LibRawData) -> *const c_char;

    pub fn ee_iso(lr: *mut LibRawData) -> c_float;
    pub fn ee_shutter(lr: *mut LibRawData) -> c_float;
    pub fn ee_aperture(lr: *mut LibRawData) -> c_float;
    pub fn ee_focal_length(lr: *mut LibRawData) -> c_float;
    pub fn ee_timestamp(lr: *mut LibRawData) -> c_longlong;

    pub fn ee_raw_width(lr: *mut LibRawData) -> c_int;
    pub fn ee_raw_height(lr: *mut LibRawData) -> c_int;
    pub fn ee_image_width(lr: *mut LibRawData) -> c_int;
    pub fn ee_image_height(lr: *mut LibRawData) -> c_int;
    pub fn ee_flip(lr: *mut LibRawData) -> c_int;

    pub fn ee_cam_mul(lr: *mut LibRawData, i: c_int) -> c_float;
    pub fn ee_pre_mul(lr: *mut LibRawData, i: c_int) -> c_float;
    pub fn ee_rgb_cam(lr: *mut LibRawData, row: c_int, col: c_int) -> c_float;
    pub fn ee_cam_xyz(lr: *mut LibRawData, row: c_int, col: c_int) -> c_float;
    pub fn ee_colors(lr: *mut LibRawData) -> c_int;
    pub fn ee_filters(lr: *mut LibRawData) -> c_uint;
    pub fn ee_white_level(lr: *mut LibRawData) -> c_uint;

    pub fn ee_thumb_count(lr: *mut LibRawData) -> c_int;
    pub fn ee_thumb_item_width(lr: *mut LibRawData, i: c_int) -> c_int;
    pub fn ee_thumb_item_height(lr: *mut LibRawData, i: c_int) -> c_int;
    pub fn ee_thumb_item_is_jpeg(lr: *mut LibRawData, i: c_int) -> c_int;

    pub fn ee_image_type(image: *const ProcessedImage) -> c_int;
    pub fn ee_image_out_width(image: *const ProcessedImage) -> c_int;
    pub fn ee_image_out_height(image: *const ProcessedImage) -> c_int;
    pub fn ee_image_out_colors(image: *const ProcessedImage) -> c_int;
    pub fn ee_image_out_bits(image: *const ProcessedImage) -> c_int;
    pub fn ee_image_out_size(image: *const ProcessedImage) -> c_uint;
    pub fn ee_image_out_data(image: *const ProcessedImage) -> *const c_uchar;
    pub fn ee_image_type_jpeg() -> c_int;
    pub fn ee_image_type_bitmap() -> c_int;
}
