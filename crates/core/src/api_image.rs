//! napi exports for the JPEG/RGBA image functions in [`crate::image`].
//! Same rules as [`crate::api`]: every function returns a Promise and runs on
//! the libuv threadpool.

use crate::image::{self, Rgba8};
use napi::bindgen_prelude::{AsyncTask, Buffer, Uint8Array};
use napi::{Env, Task};
use napi_derive::napi;

/// A decoded or resized image: `rgba` is `width * height * 4` bytes.
#[napi(object, js_name = "NativeRgbaImage")]
pub struct RgbaImageJs {
    pub width: u32,
    pub height: u32,
    pub rgba: Buffer,
}

impl From<Rgba8> for RgbaImageJs {
    fn from(i: Rgba8) -> Self {
        RgbaImageJs {
            width: i.width,
            height: i.height,
            rgba: i.rgba.into(),
        }
    }
}

// --- decodeJpeg ----------------------------------------------------------------

#[napi(object, js_name = "DecodeJpegOptions")]
pub struct DecodeJpegOptions {
    /// Return the pixels as stored instead of applying the EXIF orientation.
    pub skip_orientation: Option<bool>,
}

pub struct DecodeJpegTask {
    jpeg: Uint8Array,
    orient: bool,
}

impl Task for DecodeJpegTask {
    type Output = Rgba8;
    type JsValue = RgbaImageJs;

    fn compute(&mut self) -> napi::Result<Rgba8> {
        Ok(image::decode_jpeg(&self.jpeg, self.orient)?)
    }

    fn resolve(&mut self, _env: Env, output: Rgba8) -> napi::Result<RgbaImageJs> {
        Ok(output.into())
    }
}

/// Decodes a JPEG to 8-bit RGBA, applying its EXIF orientation unless told not to.
#[napi(ts_return_type = "Promise<NativeRgbaImage>")]
pub fn decode_jpeg(
    jpeg: Uint8Array,
    options: Option<DecodeJpegOptions>,
) -> AsyncTask<DecodeJpegTask> {
    let orient = !options.and_then(|o| o.skip_orientation).unwrap_or(false);
    AsyncTask::new(DecodeJpegTask { jpeg, orient })
}
