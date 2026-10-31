# Camera profiles

Lightroom renders a raw through a _profile_. Adobe's profiles are Adobe's files, so this app
does not ship them: you point it at your own copies and it reads them where they are (nothing
is copied into the app or the repository).

- **macOS and Windows.** Install the free [Adobe DNG
  Converter](https://helpx.adobe.com/camera-raw/using/adobe-dng-converter.html) (Lightroom
  Classic and Photoshop's Camera Raw install the same files). The profiles are in
  `/Library/Application Support/Adobe/CameraRaw/CameraProfiles` (macOS) and
  `C:\ProgramData\Adobe\CameraRaw\CameraProfiles` (Windows); the app searches those folders and
  the per-user `CameraProfiles` folder (`~/Library/Application Support/Adobe/CameraRaw/CameraProfiles`,
  `%APPDATA%\Adobe\CameraRaw\CameraProfiles`) by itself. Adobe Standard and the Camera Matching
  profiles are `.dcp` files in subfolders there.
- **Linux.** Adobe has no Linux installer. Copy the `CameraProfiles` folder from a Mac or
  Windows machine, then add it in _Settings → Profiles → Add folder…_ (or from _Browse profile
  folders…_ under Profile in the Develop panel). Folders are scanned recursively for `.dcp`
  and `.xmp` files.
- XMP profiles such as Adobe Color, Landscape, Portrait, Vivid and Neutral are `.xmp` files with
  an HSV table. They are found in any folder you add; if Adobe's installer puts them
  elsewhere on your machine, add that folder too.

The Profile select at the top of the Develop panel offers the profiles made for the photo's
camera, grouped Adobe Raw / Camera Matching / Other. The choice is written to the sidecar as
`crs:CameraProfile` (and `crs:Look` for an XMP profile), using Lightroom's keys. A photo
whose sidecar names a profile this machine does not have keeps the name, says so in the
panel and is drawn with the camera matrix. For a development test against real profiles, set
`EE_PROFILE_DIR` to the profile folder and `EE_SAMPLE_NEF_DIR` to a folder of NEFs.
