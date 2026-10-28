# Lightroom crop reference

Drop a real Lightroom crop reference here to validate the `crs:` mapping:

- `lightroom.xmp` — the XMP sidecar Lightroom writes for the cropped photo
  (or its embedded XMP, saved as a `.xmp` file). It must contain
  `crs:CropLeft/Top/Right/Bottom/Angle` and `crs:HasCrop`.
- `original.json` — the oriented, uncropped pixel dimensions of the source:
  `{ "width": 6048, "height": 4024 }`.
- `exported.jpg` — the JPEG Lightroom exports from that crop at full
  resolution, with no resize.

`packages/develop-gl/test/lr-crop-fixture.test.ts` then checks that the
output dimensions our crop geometry predicts match the exported JPEG (within
two pixels, to allow Lightroom's output rounding). The test skips when any file
is missing.
