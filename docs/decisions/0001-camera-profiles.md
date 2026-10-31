# 0001 Camera profiles

- Status: accepted
- Scope: how a raw is rendered through an Adobe camera profile or XMP look.

## Context

Lightroom renders a raw through a *profile*; the biggest remaining colour difference to Lightroom
was that this app used LibRaw's camera matrix and its own highlight shoulder. A profile gives the
Adobe rendering: the camera's matrices, a hue/saturation/value table, a look table and the tone
curve. **Adobe's profile files are not shipped**: the user supplies them (see
[Camera profiles](../camera-profiles.md)), the app reads them where they are and never
copies them into the repo, userData or fixtures.


## Decision

- **Formats.** DNG camera profiles (`.dcp`, DNG specification 1.6) and Adobe's XMP profiles
  (`.xmp` with `crs:PresetType="Look"`, e.g. Adobe Color/Landscape/Portrait/Vivid/Neutral), whose
  table is a DNG SDK "big table" (zlib, Adobe's base 85) in a `crs:Table_<md5>` attribute named by
  `crs:LookTable`, plus a `ToneCurvePV2012` and a few develop values. The format and the rendering
  order follow the Adobe DNG SDK and RAWmakase (MIT; its `docs/lightroom-profiles.md` and
  `crates/rawmakase-model/src/camera_profiles`), ported to TypeScript with attribution in the
  README.
- **Parsers** (`packages/develop-gl/src/profile`, `@ee/develop-gl/profile`, Node only): `dcp.ts`
  reads the IFD (tags `ColorMatrix1/2`, `ForwardMatrix1/2`, `CalibrationIlluminant1/2`,
  `ProfileHueSatMapDims/Data1/Data2/Encoding`, `ProfileLookTableDims/Data/Encoding`,
  `ProfileToneCurve`, `BaselineExposureOffset`, `DefaultBlackRender`, `ProfileName`,
  `ProfileEmbedPolicy`, `UniqueCameraModel`, `ProfileCopyright`); `look.ts` reads XMP looks.
  They throw `ProfileParseError` with the reason for what they cannot render: a third calibration
  illuminant (those tag numbers could not be verified without a real file), HDR profiles, RGB tables
  (Adobe's Artistic/Vintage/Modern looks), monochrome looks, looks without a base profile, and any
  develop setting in a look other than Highlights, Shadows, Contrast, Blacks and Clarity.
- **Backend** (`ProfileLibrary`, `jobs/backend/profiles.ts`): scans Adobe's folders where they
  exist (macOS `/Library/Application Support/Adobe/CameraRaw/CameraProfiles` and the per-user one,
  Windows `%ProgramData%\Adobe\CameraRaw\CameraProfiles` and `%APPDATA%\...`; none on Linux, where
  the user copies the folder over) plus `AppSettings.profileFolders`, recursively. A DCP is
  identified from the first 64 kB; XMP files without `PresetType="Look"` (presets) are ignored. A
  profile is matched to a photo by `UniqueCameraModel` against EXIF make and model, compared without
  case, spaces and underscores (`Nikon Z 6_2` = `Z 6 2`). Another camera's profile is never used.
  Groups are Lightroom's: *Adobe Raw* (names starting `Adobe `, looks in the `Profiles` group),
  *Camera Matching* (`Camera ...`, or under a `Camera Matching` folder) and *Other*. IPC:
  `profiles:list` (what fits a photo; empty for JPEG/TIFF), `profiles:index` (Settings), and
  `profiles:resolve` (the parsed profile a sidecar names, or `missing` with the reason).
- **Parameters.** `crs:CameraProfile` (the DCP name; for an XMP look, its base profile) and
  `crs:CameraProfileDigest` (kept, never computed) are scalars; `crs:Look` is a struct
  (`Name`, `UUID`, `Amount`) as Lightroom 7+ writes it, and is `EditParams.LookName/LookUUID/LookAmount`
  (Amount 1 = 100 %, 0..2). Presets read the same keys (`parsePresetXmp` reads the `crs:Look` struct);
  `applyPreset` replaces the profile whole, so a camera profile drops the previous look. A preset
  that names a profile this machine does not have still sets the name: the panel says "not in the
  profile folders" and the picture is drawn with the camera matrix (the sidecar keeps the name for
  Lightroom). Exports (rendered directly at the preset's output size) and thumbnails draw what
  the canvas shows. Copy/Paste/Sync Settings has a first group, *Treatment & Profile*, holding
  `CameraProfile`, `CameraProfileDigest` and the look fields.
- **Pipeline order** (CPU: `profile/render.ts`, shader: `glsl/profile.ts`; the stages are their own
  files, the shaders have two insertion points `baseColor` and `profileFinish`):

  ```
  camera RGB * multipliers (+ highlight clip, lens gain)
    -> ForwardMatrix(T) -> XYZ D50 -> linear ProPhoto            u_color  (replaces cameraToSrgb)
    -> HueSatMap (HSV table, trilinear, blended by T)             in ProPhoto, before exposure
    -> * 2^BaselineExposureOffset -> linear Rec.709               base pass ends here
    -> calibration, Exposure, tone (Highlights/Shadows/Contrast/Whites/Blacks)   unchanged
    -> ProPhoto: LookTable -> XMP look table -> ProfileToneCurve -> XMP look curve  replaces the shoulder
    -> Rec.709 -> sRGB OETF -> point curves, vibrance, mixer, grading ...      unchanged
  ```

  The neighbourhood stages (Texture, Clarity, Dehaze, noise reduction) work on the base pass, so
  they see the HueSatMap but not the look tables and tone curve, as they see the shoulder-less
  linear image today. `u_color` holds the profile's camera-to-ProPhoto matrix, so the base pass
  changes in one place. Without a profile nothing changes: `cameraToSrgb`, the shoulder, the same
  shader branches off.
- **White balance** through the profile, like the DNG SDK's `dng_color_spec`: the profile's
  `ColorMatrix` (interpolated between the two calibration illuminants, linearly in inverse
  temperature of the white, clamped to the illuminants: `(1/T - 1/T1) / (1/T2 - 1/T1)`) turns a
  chosen temperature and tint into multipliers, and the as-shot multipliers into the as-shot
  temperature (by the SDK's fixed-point iteration, since the matrix depends on the answer). The
  ForwardMatrix and the HueSatMaps use the white's temperature the same way. A profile with only
  a ColorMatrix is adapted from the white to D50 with Bradford, as the SDK does. The forward
  matrix is scaled by `1 / min(multipliers)`, because the SDK normalises the neutral so its largest
  channel is 1 and this app normalises green to 1.
- **Develop tools.** The white balance picker and Auto white balance solve camera gains for a
  neutral and turn them into a temperature and tint; with a profile active they use the profile's
  interpolated ColorMatrix (`profileColorModel`, the SDK's iteration) instead of LibRaw's matrix, so
  the slider values the render turns back into gains give the picked neutral. The histogram, the
  clipping overlay and Auto tone read the canvas / a render of the same renderer, so they measure the
  profile render. The before side of the before/after split is drawn through the profile only when its
  settings name the profile in use.
- **HueSatMap and LookTable** are the SDK's `dng_hue_sat_map`: HSV of the linear ProPhoto colour
  (the value axis sRGB encoded when the table says so), hue 0..1 wrapping, trilinear in
  (hue, saturation, value), node = (hue shift in degrees, saturation scale, value scale), node
  order value, hue, saturation. Negative channels count as 0; the value keeps its headroom above 1
  (the lookup clamps, the scale applies). On the GPU they are 3D RGBA32F textures read with
  `texelFetch` and interpolated in the shader, so no float-filtering extension is needed and the
  arithmetic is the CPU's. Texture units: image 0, curve 1, profile tone 2, tables 3..6; every
  program that includes the profile samplers gets all of them set, because two sampler types on one
  unit are a draw error.
- **Tone curve.** `ProfileToneCurve` (or the DNG default ACR 3 curve, from the SDK's published 1025
  samples, when the tag is absent) is sampled into a 4097-entry table (monotone cubic spline through
  the points; the SDK's own spline solver differs by far less than a table step on Adobe's dense
  curves) and applied as the SDK's RGB tone: it maps the lowest and highest channel and the middle one
  keeps its relative position, so hue is kept. Channels are clamped to 0..1 first, which is the
  highlight clip that the shoulder avoided. The user's Exposure and tone sliders act before it,
  in scene-referred light, which is where Lightroom puts them relative to the profile curve.
- **XMP looks.** The look's HSV table goes right after the profile's LookTable, its tone curve after
  the profile's (in sRGB-encoded values, hue preserving). Amount (0..200 %) scales the table
  between the bounds a version-2 table stores (a version-1 table stays at 100 %), blends the curve
  (above 100 % the curve is applied again at the excess) and scales the look's develop values
  (Highlights, Shadows, Contrast, Blacks, Clarity) added to the user's sliders in proportion up to 100 % and
  at half the rate above, as Camera Raw 18.7 was measured by RAWmakase. A look that does not support
  an Amount ignores it.

## Consequences

- **Not done**: `DefaultBlackRender` (parsed; the SDK's "auto" black subtraction is not applied,
  and Adobe's Camera Matching profiles say none anyway); the camera's own `BaselineExposure` (the
  profile's `BaselineExposureOffset` is applied; LibRaw's header carries no per-camera baseline);
  RGB-table looks; three-illuminant profiles; embedding profiles in the sidecar (`ProfileEmbedPolicy`
  is parsed and nothing is ever embedded or copied); `crs:CameraProfileDigest` is kept, not checked.
  The result has not been compared with a Lightroom export (no real profile was available while
  building it): the tests prove the maths against the DNG SDK formulas and the GPU against the CPU,
  and `EE_PROFILE_DIR` / `EE_SAMPLE_NEF_DIR` enable a render of a Z 6 NEF with Adobe Standard for a
  visual check.
- **Tests**: `packages/develop-gl/test/profile*.test.ts` (parser round trip, SDK interpolation, table
  lookup with hue wrap, identity profile = no profile, white balance, look amount),
  `profile.browser.test.ts` (GPU vs CPU, 33 cases with two illuminants, tables and a look),
  `apps/desktop/test/profiles.test.ts` (folders, matching, resolve), `packages/metadata` (sidecar
  round trip). All use profiles written by the tests (`src/profile/testing.ts`); none is an Adobe file.
