//! napi export for [`crate::drives`]. Like every export it runs on the libuv
//! threadpool, so a drive that stalls cannot block the JS thread.

use crate::drives::{self, DriveInfo};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

/// Type and volume label of one drive root.
#[napi(object, js_name = "NativeDriveInfo")]
pub struct DriveInfoJs {
    /// The root as asked for, e.g. `E:\`.
    pub root: String,
    /// `GetDriveTypeW`: 1 no volume, 2 removable, 3 fixed, 4 network, 5 optical.
    pub drive_type: u32,
    /// The volume label; absent when the volume has none or was not read.
    pub label: Option<String>,
    /// Win32 error of reading the volume (21 for an empty card reader slot).
    pub error_code: Option<u32>,
}

impl From<DriveInfo> for DriveInfoJs {
    fn from(info: DriveInfo) -> Self {
        DriveInfoJs {
            root: info.root,
            drive_type: info.drive_type,
            label: info.label,
            error_code: info.error_code,
        }
    }
}

pub struct ReadDriveInfoTask {
    roots: Vec<String>,
}

impl Task for ReadDriveInfoTask {
    type Output = Vec<DriveInfo>;
    type JsValue = Vec<DriveInfoJs>;

    fn compute(&mut self) -> napi::Result<Vec<DriveInfo>> {
        Ok(drives::read_drive_info(&self.roots))
    }

    fn resolve(&mut self, _env: Env, output: Vec<DriveInfo>) -> napi::Result<Vec<DriveInfoJs>> {
        Ok(output.into_iter().map(Into::into).collect())
    }
}

/// Drive type and volume label of each drive root (`E:\`), in order. Only removable and
/// fixed drives are asked for a label; network, optical and missing drives are never
/// touched. Resolves to an empty list off Windows.
#[napi(ts_return_type = "Promise<NativeDriveInfo[]>")]
pub fn read_drive_info(roots: Vec<String>) -> AsyncTask<ReadDriveInfoTask> {
    AsyncTask::new(ReadDriveInfoTask { roots })
}
