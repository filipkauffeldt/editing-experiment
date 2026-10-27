//! napi-rs exports. Every function returns a Promise: the work runs on the
//! libuv threadpool (`AsyncTask`), never on the JS thread.
//!
//! The objects here are plain data shaped like the TS types in
//! `packages/contracts`; `src/index.ts` adds the precise TS types on top.

use crate::decode::{self, DecodeOptions, LinearImage};
use crate::error::Error;
use crate::info::{self, RawInfo};
use crate::preview::{self, Preview};
use crate::resample::SampleType;
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Status, Task};
use napi_derive::napi;
use std::path::PathBuf;

impl From<Error> for napi::Error {
    fn from(error: Error) -> Self {
        let status = match error {
            Error::InvalidArgument(_) => Status::InvalidArg,
            _ => Status::GenericFailure,
        };
        napi::Error::new(status, error.to_string())
    }
}

// --- readRawInfo --------------------------------------------------------------

/// Camera, exposure and geometry metadata of a raw file.
#[napi(object, js_name = "RawInfo")]
pub struct RawInfoJs {
    pub make: String,
    pub model: String,
    pub lens: Option<String>,
    pub serial: Option<String>,
    /// Camera local time `YYYY-MM-DDTHH:MM:SS` (no zone, EXIF has none).
    pub capture_time: Option<String>,
    pub iso: Option<f64>,
    /// Exposure time in seconds.
    pub shutter: Option<f64>,
    /// F-number.
    pub aperture: Option<f64>,
    /// Focal length in millimetres.
    pub focal_length: Option<f64>,
    /// EXIF orientation, 1..=8.
    pub orientation: u32,
    /// Sensor readout size including masked border pixels.
    pub raw_width: u32,
    pub raw_height: u32,
    /// Size of the displayed image (orientation applied).
    pub width: u32,
    pub height: u32,
}

impl From<RawInfo> for RawInfoJs {
    fn from(i: RawInfo) -> Self {
        RawInfoJs {
            make: i.make,
            model: i.model,
            lens: i.lens,
            serial: i.serial,
            capture_time: i.capture_time,
            iso: i.iso,
            shutter: i.shutter,
            aperture: i.aperture,
            focal_length: i.focal_length,
            orientation: u32::from(i.orientation),
            raw_width: i.raw_width,
            raw_height: i.raw_height,
            width: i.width,
            height: i.height,
        }
    }
}

pub struct ReadRawInfoTask {
    path: PathBuf,
}

impl Task for ReadRawInfoTask {
    type Output = RawInfo;
    type JsValue = RawInfoJs;

    fn compute(&mut self) -> napi::Result<RawInfo> {
        Ok(info::read_raw_info(&self.path)?)
    }

    fn resolve(&mut self, _env: Env, output: RawInfo) -> napi::Result<RawInfoJs> {
        Ok(output.into())
    }
}

/// Reads metadata of a raw file without decoding pixels.
#[napi(ts_return_type = "Promise<RawInfo>")]
pub fn read_raw_info(path: String) -> AsyncTask<ReadRawInfoTask> {
    AsyncTask::new(ReadRawInfoTask { path: path.into() })
}

// --- extractPreview ------------------------------------------------------------

/// The largest embedded preview of a raw file.
#[napi(object, js_name = "RawPreview")]
pub struct RawPreviewJs {
    /// A complete JPEG file.
    pub jpeg: Buffer,
    pub width: u32,
    pub height: u32,
    /// EXIF orientation (1..=8) to apply for display.
    pub orientation: u32,
}

impl From<Preview> for RawPreviewJs {
    fn from(p: Preview) -> Self {
        RawPreviewJs {
            jpeg: p.jpeg.into(),
            width: p.width,
            height: p.height,
            orientation: u32::from(p.orientation),
        }
    }
}

pub struct ExtractPreviewTask {
    path: PathBuf,
}

impl Task for ExtractPreviewTask {
    type Output = Preview;
    type JsValue = RawPreviewJs;

    fn compute(&mut self) -> napi::Result<Preview> {
        Ok(preview::extract_preview(&self.path)?)
    }

    fn resolve(&mut self, _env: Env, output: Preview) -> napi::Result<RawPreviewJs> {
        Ok(output.into())
    }
}

/// Extracts the largest embedded preview as a JPEG.
#[napi(ts_return_type = "Promise<RawPreview>")]
pub fn extract_preview(path: String) -> AsyncTask<ExtractPreviewTask> {
    AsyncTask::new(ExtractPreviewTask { path: path.into() })
}

// --- decodeLinear ---------------------------------------------------------------

#[napi(object, js_name = "DecodeLinearOptions")]
pub struct DecodeLinearOptionsJs {
    /// Longest edge of the result; never upscales. Default: full size.
    pub max_edge: Option<u32>,
    /// `'f16'` (default) or `'f32'`.
    pub sample_type: Option<String>,
}

#[napi(object)]
pub struct Multipliers {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

/// Same fields as `LinearImageHeader` in `packages/contracts`.
#[napi(object, js_name = "NativeLinearImageHeader")]
pub struct LinearHeaderJs {
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub sample_type: String,
    pub as_shot_multipliers: Multipliers,
    pub camera_to_srgb: Vec<f64>,
    pub xyz_to_camera: Vec<f64>,
}

#[napi(object, js_name = "NativeLinearImage")]
pub struct LinearImageJs {
    pub header: LinearHeaderJs,
    /// `width * height * 4` RGBA samples, little-endian.
    pub data: Buffer,
}

fn sample_type_name(sample: SampleType) -> &'static str {
    match sample {
        SampleType::F16 => "f16",
        SampleType::F32 => "f32",
    }
}

fn parse_sample_type(name: Option<&str>) -> Result<SampleType, Error> {
    match name {
        None | Some("f16") => Ok(SampleType::F16),
        Some("f32") => Ok(SampleType::F32),
        Some(other) => Err(Error::InvalidArgument(format!(
            "sampleType must be 'f16' or 'f32', got '{other}'"
        ))),
    }
}

impl From<LinearImage> for LinearImageJs {
    fn from(image: LinearImage) -> Self {
        let h = image.header;
        let [r, g, b] = h.as_shot_multipliers;
        LinearImageJs {
            header: LinearHeaderJs {
                width: h.width,
                height: h.height,
                source_width: h.source_width,
                source_height: h.source_height,
                sample_type: sample_type_name(h.sample_type).to_owned(),
                as_shot_multipliers: Multipliers { r, g, b },
                camera_to_srgb: h.camera_to_srgb.to_vec(),
                xyz_to_camera: h.xyz_to_camera.to_vec(),
            },
            data: image.data.into(),
        }
    }
}

pub struct DecodeLinearTask {
    path: PathBuf,
    options: Result<DecodeOptions, String>,
}

impl Task for DecodeLinearTask {
    type Output = LinearImage;
    type JsValue = LinearImageJs;

    fn compute(&mut self) -> napi::Result<LinearImage> {
        let options = self
            .options
            .clone()
            .map_err(|message| napi::Error::new(Status::InvalidArg, message))?;
        Ok(decode::decode_linear(&self.path, options)?)
    }

    fn resolve(&mut self, _env: Env, output: LinearImage) -> napi::Result<LinearImageJs> {
        Ok(output.into())
    }
}

/// Decodes a raw to demosaiced linear camera RGB (see "Linear image format"
/// in `docs/ARCHITECTURE.md`).
#[napi(ts_return_type = "Promise<NativeLinearImage>")]
pub fn decode_linear(
    path: String,
    options: Option<DecodeLinearOptionsJs>,
) -> AsyncTask<DecodeLinearTask> {
    let options = options.unwrap_or(DecodeLinearOptionsJs {
        max_edge: None,
        sample_type: None,
    });
    // Validation errors surface as a rejected promise, like every other error.
    let parsed = parse_sample_type(options.sample_type.as_deref())
        .map(|sample_type| DecodeOptions {
            max_edge: options.max_edge,
            sample_type,
        })
        .map_err(|e| e.to_string());
    AsyncTask::new(DecodeLinearTask {
        path: path.into(),
        options: parsed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_type_names_round_trip() {
        assert_eq!(parse_sample_type(None).unwrap(), SampleType::F16);
        assert_eq!(parse_sample_type(Some("f32")).unwrap(), SampleType::F32);
        assert_eq!(sample_type_name(SampleType::F16), "f16");
        assert!(parse_sample_type(Some("f64")).is_err());
    }
}
