//! Volume labels and drive types of Windows drive roots.
//!
//! Node has no API for the label of a volume, so the card scanner asks here. The
//! Win32 calls are declared by hand (kernel32 only, no `windows`/`winapi` crate).
//! On other platforms [`read_drive_info`] returns nothing: the scanner then keeps
//! its generic names.
//!
//! The calls can block on a stalled drive, so callers run them on the libuv
//! threadpool (see [`crate::api_drives`]) and ask for one root at a time when one
//! slow drive must not hold up the others.

/// `GetDriveTypeW` result for a drive that is neither of the kinds below.
pub const DRIVE_UNKNOWN: u32 = 0;
/// No volume is mounted at the root (the letter is unused).
pub const DRIVE_NO_ROOT_DIR: u32 = 1;
pub const DRIVE_REMOVABLE: u32 = 2;
pub const DRIVE_FIXED: u32 = 3;
pub const DRIVE_REMOTE: u32 = 4;
pub const DRIVE_CDROM: u32 = 5;

/// `ERROR_INVALID_PARAMETER`: the root is not of the form `X:\`.
pub const ERROR_INVALID_PARAMETER: u32 = 87;

/// What Windows says about one drive root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveInfo {
    /// The root as it was asked for, e.g. `E:\`.
    pub root: String,
    /// `GetDriveTypeW`, one of the `DRIVE_*` constants.
    pub drive_type: u32,
    /// The volume label. `None` when the volume has none, or when it was not read.
    pub label: Option<String>,
    /// The Win32 error of `GetVolumeInformationW` when it failed (21 `ERROR_NOT_READY`
    /// for an empty card reader slot). `None` when it succeeded or was not called.
    pub error_code: Option<u32>,
}

/// Longest volume label buffer Windows needs: `MAX_PATH + 1` UTF-16 units.
pub const LABEL_BUFFER_LEN: usize = 261;

/// Only drives of these types are asked for their label. Network, optical and
/// missing drives are left alone: `GetVolumeInformationW` on them can hang or
/// prompt, and none of them is a camera card.
pub fn is_label_readable(drive_type: u32) -> bool {
    drive_type == DRIVE_REMOVABLE || drive_type == DRIVE_FIXED
}

/// `X:\` with an ASCII drive letter. Anything else (UNC paths, volume GUIDs,
/// relative paths) is refused, so a caller cannot make this touch a share.
pub fn is_drive_root(root: &str) -> bool {
    let bytes = root.as_bytes();
    bytes.len() == 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

/// Decodes the NUL-terminated UTF-16 label `GetVolumeInformationW` wrote into
/// `buffer`. Only the units before the first NUL count; the rest of the buffer
/// is whatever it held before. A label that is empty gives `None`.
pub fn label_from_utf16(buffer: &[u16]) -> Option<String> {
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    // Lone surrogates cannot occur in a valid label; if one does, keep the rest.
    let label = String::from_utf16_lossy(&buffer[..end]);
    let label = label.trim();
    (!label.is_empty()).then(|| label.to_owned())
}

/// Reads the type and label of each root, in order.
///
/// A root that is not a drive-letter root is reported with `DRIVE_UNKNOWN` and
/// `ERROR_INVALID_PARAMETER` without being touched. Off Windows this returns an
/// empty list.
pub fn read_drive_info(roots: &[String]) -> Vec<DriveInfo> {
    #[cfg(windows)]
    {
        windows::read_drive_info(roots)
    }
    #[cfg(not(windows))]
    {
        let _ = roots;
        Vec::new()
    }
}

#[cfg(windows)]
mod windows {
    use super::{
        DRIVE_UNKNOWN, DriveInfo, ERROR_INVALID_PARAMETER, LABEL_BUFFER_LEN, is_drive_root,
        is_label_readable, label_from_utf16,
    };
    use std::io;
    use std::ptr;

    /// `SEM_FAILCRITICALERRORS`: fail a call on a drive with no disk instead of
    /// showing the "There is no disk in the drive" dialog.
    const SEM_FAILCRITICALERRORS: u32 = 0x0001;

    // Hand-written, kernel32 only. All strings are NUL-terminated UTF-16.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
        #[allow(clippy::too_many_arguments)]
        fn GetVolumeInformationW(
            root_path_name: *const u16,
            volume_name_buffer: *mut u16,
            volume_name_size: u32,
            volume_serial_number: *mut u32,
            maximum_component_length: *mut u32,
            file_system_flags: *mut u32,
            file_system_name_buffer: *mut u16,
            file_system_name_size: u32,
        ) -> i32;
        fn SetThreadErrorMode(new_mode: u32, old_mode: *mut u32) -> i32;
    }

    /// Sets `SEM_FAILCRITICALERRORS` for this thread and puts the old mode back on drop.
    struct FailCriticalErrors {
        previous: u32,
    }

    impl FailCriticalErrors {
        fn enable() -> io::Result<Self> {
            let mut previous = 0u32;
            // SAFETY: `previous` is a valid out pointer for the duration of the call.
            if unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, &mut previous) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { previous })
        }
    }

    impl Drop for FailCriticalErrors {
        fn drop(&mut self) {
            // SAFETY: a null old-mode pointer is allowed. Nothing useful can be done if
            // restoring fails, and this thread belongs to the libuv pool anyway.
            unsafe {
                SetThreadErrorMode(self.previous, ptr::null_mut());
            }
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read_drive_info(roots: &[String]) -> Vec<DriveInfo> {
        // Without the error mode an empty slot could open a system dialog, so if it
        // cannot be set no volume is queried; the types are still reported.
        let guard = FailCriticalErrors::enable();
        let mode_error = guard
            .as_ref()
            .err()
            .map(|e| e.raw_os_error().map_or(1, |code| code as u32));

        let infos = roots
            .iter()
            .map(|root| {
                if !is_drive_root(root) {
                    return DriveInfo {
                        root: root.clone(),
                        drive_type: DRIVE_UNKNOWN,
                        label: None,
                        error_code: Some(ERROR_INVALID_PARAMETER),
                    };
                }
                let root_wide = wide(root);
                // SAFETY: `root_wide` is NUL-terminated and outlives the call.
                let drive_type = unsafe { GetDriveTypeW(root_wide.as_ptr()) };
                if !is_label_readable(drive_type) {
                    return DriveInfo {
                        root: root.clone(),
                        drive_type,
                        label: None,
                        error_code: None,
                    };
                }
                if let Some(code) = mode_error {
                    return DriveInfo {
                        root: root.clone(),
                        drive_type,
                        label: None,
                        error_code: Some(code),
                    };
                }
                let mut label = [0u16; LABEL_BUFFER_LEN];
                // SAFETY: the buffer length passed is the buffer's real length in
                // units, the optional out parameters are null, `root_wide` is
                // NUL-terminated.
                let ok = unsafe {
                    GetVolumeInformationW(
                        root_wide.as_ptr(),
                        label.as_mut_ptr(),
                        LABEL_BUFFER_LEN as u32,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        0,
                    )
                };
                if ok == 0 {
                    let code = io::Error::last_os_error()
                        .raw_os_error()
                        .map_or(1, |code| code as u32);
                    return DriveInfo {
                        root: root.clone(),
                        drive_type,
                        label: None,
                        error_code: Some(code),
                    };
                }
                DriveInfo {
                    root: root.clone(),
                    drive_type,
                    label: label_from_utf16(&label),
                    error_code: None,
                }
            })
            .collect();
        drop(guard);
        infos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn decodes_swedish_letters() {
        let mut buffer = utf16("ÅÄÖ Åre 2026");
        buffer.resize(LABEL_BUFFER_LEN, 0);
        assert_eq!(label_from_utf16(&buffer).as_deref(), Some("ÅÄÖ Åre 2026"));
    }

    #[test]
    fn stops_at_the_first_nul_and_ignores_stale_buffer_content() {
        let mut buffer = utf16("NIKON Z 6");
        buffer.push(0);
        buffer.extend(utf16("old leftovers"));
        assert_eq!(label_from_utf16(&buffer).as_deref(), Some("NIKON Z 6"));
    }

    #[test]
    fn a_label_that_fills_the_whole_buffer_has_no_terminator() {
        let buffer = utf16("ABC");
        assert_eq!(label_from_utf16(&buffer).as_deref(), Some("ABC"));
    }

    #[test]
    fn an_empty_label_is_none() {
        assert_eq!(label_from_utf16(&[0; LABEL_BUFFER_LEN]), None);
        assert_eq!(label_from_utf16(&[]), None);
    }

    #[test]
    fn a_label_of_spaces_is_none() {
        let mut buffer = utf16("   ");
        buffer.resize(LABEL_BUFFER_LEN, 0);
        assert_eq!(label_from_utf16(&buffer), None);
    }

    #[test]
    fn decodes_characters_outside_the_basic_plane() {
        let mut buffer = utf16("CARD 📷");
        buffer.resize(LABEL_BUFFER_LEN, 0);
        assert_eq!(label_from_utf16(&buffer).as_deref(), Some("CARD 📷"));
    }

    #[test]
    fn only_drive_letter_roots_are_accepted() {
        assert!(is_drive_root("E:\\"));
        assert!(is_drive_root("z:\\"));
        assert!(!is_drive_root("E:"));
        assert!(!is_drive_root("E:\\DCIM"));
        assert!(!is_drive_root("\\\\server\\share\\"));
        assert!(!is_drive_root("\\\\?\\Volume{1234}\\"));
        assert!(!is_drive_root("1:\\"));
        assert!(!is_drive_root(""));
    }

    #[test]
    fn only_removable_and_fixed_drives_are_read() {
        assert!(is_label_readable(DRIVE_REMOVABLE));
        assert!(is_label_readable(DRIVE_FIXED));
        for other in [
            DRIVE_UNKNOWN,
            DRIVE_NO_ROOT_DIR,
            DRIVE_REMOTE,
            DRIVE_CDROM,
            6,
        ] {
            assert!(!is_label_readable(other));
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn reports_nothing_off_windows() {
        assert!(read_drive_info(&["E:\\".to_owned()]).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn the_system_drive_is_a_fixed_drive_that_reads_without_error() {
        let infos = read_drive_info(&["C:\\".to_owned()]);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].root, "C:\\");
        assert_eq!(infos[0].drive_type, DRIVE_FIXED);
        assert_eq!(infos[0].error_code, None);
    }

    #[cfg(windows)]
    #[test]
    fn an_unused_letter_has_no_root_directory() {
        // The last letter that is not in use on this machine.
        let unused = ('A'..='Z')
            .rev()
            .map(|letter| format!("{letter}:\\"))
            .find(|root| {
                read_drive_info(std::slice::from_ref(root))[0].drive_type == DRIVE_NO_ROOT_DIR
            })
            .expect("at least one drive letter is unused");
        let infos = read_drive_info(std::slice::from_ref(&unused));
        assert_eq!(infos[0].drive_type, DRIVE_NO_ROOT_DIR);
        assert_eq!(infos[0].label, None);
        assert_eq!(infos[0].error_code, None);
    }

    #[cfg(windows)]
    #[test]
    fn refuses_roots_that_are_not_drive_letters() {
        let infos = read_drive_info(&["\\\\localhost\\C$\\".to_owned(), "C:\\Windows".to_owned()]);
        assert_eq!(infos.len(), 2);
        for info in infos {
            assert_eq!(info.drive_type, DRIVE_UNKNOWN);
            assert_eq!(info.error_code, Some(ERROR_INVALID_PARAMETER));
        }
    }

    #[cfg(windows)]
    #[test]
    fn leaves_the_thread_error_mode_as_it_found_it() {
        // SAFETY: plain kernel32 calls with valid pointers.
        unsafe extern "system" {
            fn GetThreadErrorMode() -> u32;
        }
        let before = unsafe { GetThreadErrorMode() };
        read_drive_info(&["C:\\".to_owned()]);
        assert_eq!(unsafe { GetThreadErrorMode() }, before);
    }
}
