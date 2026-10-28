//! napi exports for the JPEG/RGBA image functions in [`crate::image`].
//! Same rules as [`crate::api`]: every function returns a Promise and runs on
//! the libuv threadpool.

use crate::error::Error;
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

// --- resizeRgba ----------------------------------------------------------------

#[napi(object, js_name = "ResizeRgbaOptions")]
pub struct ResizeRgbaOptions {
    /// Longest edge of the result in pixels. Never upscales.
    pub max_edge: u32,
}

pub struct ResizeRgbaTask {
    rgba: Uint8Array,
    width: u32,
    height: u32,
    max_edge: u32,
}

impl Task for ResizeRgbaTask {
    type Output = Rgba8;
    type JsValue = RgbaImageJs;

    fn compute(&mut self) -> napi::Result<Rgba8> {
        Ok(image::resize_max_edge(
            &self.rgba,
            self.width,
            self.height,
            self.max_edge,
        )?)
    }

    fn resolve(&mut self, _env: Env, output: Rgba8) -> napi::Result<RgbaImageJs> {
        Ok(output.into())
    }
}

/// Downscales RGBA pixels with Lanczos3 so the longest edge is at most `maxEdge`.
/// Works on the sRGB-encoded values directly (not gamma-correct). Never upscales:
/// a smaller image is returned unchanged.
#[napi(ts_return_type = "Promise<NativeRgbaImage>")]
pub fn resize_rgba(
    rgba: Uint8Array,
    width: u32,
    height: u32,
    options: ResizeRgbaOptions,
) -> AsyncTask<ResizeRgbaTask> {
    AsyncTask::new(ResizeRgbaTask {
        rgba,
        width,
        height,
        max_edge: options.max_edge,
    })
}

// --- encodeJpeg ----------------------------------------------------------------

#[napi(object, js_name = "EncodeJpegOptions")]
pub struct EncodeJpegOptions {
    /// 1..=100.
    pub quality: u32,
    /// `'444'` or `'420'`.
    pub chroma: String,
    /// Embed the sRGB ICC profile.
    pub icc_srgb: bool,
    /// Progressive scan order. Default false.
    pub progressive: Option<bool>,
}

fn parse_encode_options(options: EncodeJpegOptions) -> Result<image::EncodeOptions, String> {
    let chroma = match options.chroma.as_str() {
        "444" => image::Chroma::C444,
        "420" => image::Chroma::C420,
        other => return Err(format!("chroma must be '444' or '420', got '{other}'")),
    };
    let quality = u8::try_from(options.quality)
        .ok()
        .filter(|q| (1..=100).contains(q))
        .ok_or_else(|| format!("quality must be 1..=100, got {}", options.quality))?;
    Ok(image::EncodeOptions {
        quality,
        chroma,
        icc_srgb: options.icc_srgb,
        progressive: options.progressive.unwrap_or(false),
    })
}

pub struct EncodeJpegTask {
    rgba: Uint8Array,
    width: u32,
    height: u32,
    options: Result<image::EncodeOptions, String>,
}

impl Task for EncodeJpegTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Vec<u8>> {
        let options = self.options.clone().map_err(Error::InvalidArgument)?;
        Ok(image::encode_jpeg(
            &self.rgba,
            self.width,
            self.height,
            options,
        )?)
    }

    fn resolve(&mut self, _env: Env, output: Vec<u8>) -> napi::Result<Buffer> {
        Ok(output.into())
    }
}

/// Encodes RGBA (alpha ignored) as a baseline JPEG. The file holds JFIF, the
/// sRGB ICC profile when asked for, and no EXIF, XMP or thumbnail.
#[napi(ts_return_type = "Promise<Buffer>")]
pub fn encode_jpeg(
    rgba: Uint8Array,
    width: u32,
    height: u32,
    options: EncodeJpegOptions,
) -> AsyncTask<EncodeJpegTask> {
    AsyncTask::new(EncodeJpegTask {
        rgba,
        width,
        height,
        options: parse_encode_options(options),
    })
}
