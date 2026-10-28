# Lightroom crop references

Drop one or two real Lightroom crop references here to validate the `crs:`
mapping, one per subdirectory:

- `landscape/` — a normal landscape frame (EXIF orientation 1).
- `portrait/` — a portrait frame shot with orientation 6 or 8 (rotated 90°).

Each directory needs:

- `lightroom.xmp` — the XMP sidecar Lightroom wrote for the cropped photo
  (or its embedded XMP, saved as a `.xmp` file). It must contain
  `crs:CropLeft/Top/Right/Bottom/Angle` and `crs:HasCrop`.
- `original.json` — the **oriented** uncropped dimensions and the EXIF
  orientation, e.g. `{ "width": 4024, "height": 6048, "orientation": 6 }`.
  For orientation 1 use `"orientation": 1`.
- `exported.jpg` — the JPEG Lightroom exports from that crop at full
  resolution, with **no resize**.

`packages/develop-gl/test/lr-crop-fixture.test.ts` maps the stored-space
`crs:Crop*` values to oriented space and checks that `cropOutputPixels` matches
the exported JPEG within two pixels (Lightroom output rounding), and that the
aspect ratio matches. Each reference is skipped when its files are missing.
