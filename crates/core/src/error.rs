//! Typed errors for the native core. They convert to JS `Error`s with a clear
//! message at the napi boundary (see [`crate::api`]).

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// LibRaw rejected the file because it is not a raw format it knows.
    #[error("{} is not a supported raw file ({message})", path.display())]
    UnsupportedFile { path: PathBuf, message: String },

    /// The file could not be read.
    #[error("cannot read {}: {message}", path.display())]
    Io { path: PathBuf, message: String },

    /// LibRaw failed while doing `operation` on `path`.
    #[error("{operation} failed for {}: {message} (LibRaw error {code})", path.display())]
    LibRaw {
        operation: &'static str,
        path: PathBuf,
        code: i32,
        message: String,
    },

    /// The raw has no embedded preview we can use.
    #[error("{} has no embedded preview", path.display())]
    NoPreview { path: PathBuf },

    /// An argument was out of range or malformed.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    /// Encoding an image failed.
    #[error("image encoding failed: {0}")]
    Encode(String),

    /// The image is larger than the output buffers can address.
    #[error("{width}x{height} image is too large to decode")]
    TooLarge { width: u32, height: u32 },
}

pub type Result<T> = std::result::Result<T, Error>;
