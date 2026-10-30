/**
 * @ee/develop-gl: the develop pipeline (white balance, tone, curves, colour),
 * as a WebGL2 renderer plus a CPU reference of the same maths, and the
 * Lightroom preset parser. Framework agnostic; React bindings are in
 * `@ee/develop-gl/react`.
 */

// WebGL2 renderer
export { createDevelopRenderer, DevelopGlError } from './renderer';
export type { CropViewTransform, DevelopRenderer, DevelopRendererOptions } from './renderer';

// Parameter model
export { resolveUniforms, buildCurveLut } from './params';
export type { DevelopCamera, DevelopUniforms } from './params';
export { TUNING } from './tuning';
export {
  MAX_CROP_ANGLE,
  constrainCrop,
  cropAspect,
  cropCorners,
  cropDevelopedRgba,
  cropFitsImage,
  cropFromGeometry,
  cropGeometry,
  cropImageToView,
  cropOutputPixels,
  cropOutputSize,
  cropOrientedToStored,
  cropStoredToOriented,
  cropViewToImage,
  croppedToSource,
  croppedToSourcePixels,
  drawCrop,
  isFullCrop,
  isUsableCrop,
  largestCropForAspect,
  minCropSize,
  normalizeOrientation,
  orientedToStoredPoint,
  panCrop,
  pointerAngleDelta,
  quantizeAngle,
  resizeCropFromHandle,
  rotateCrop,
  rotateCropInView,
  rotatePoint,
  sanitizeCrop,
  shrinkCropToImage,
  straightenAngleFromLine,
  sourceToCropped,
  storedSizeForOrientation,
  storedToOrientedPoint,
  sourceToCroppedPixels,
  unrotatePoint,
} from './crop';
export type {
  CropGeometry,
  CropHandle,
  DrawnCrop,
  Point as CropPoint,
  Size as CropSize,
} from './crop';
export { cropMosaicOp } from './crop-mosaic';

// White balance
export {
  asShotTemperatureTint,
  multipliersFromTemperatureTint,
  resolveWhiteBalance,
  temperatureTintFromMultipliers,
  temperatureTintToXY,
  xyToTemperatureTint,
  WHITE_BALANCE_PRESETS,
} from './wb';
export type {
  Multipliers,
  ResolvedWhiteBalance,
  TemperatureTint,
  WhiteBalanceCamera,
  XY,
} from './wb';

// Lens corrections
export { resolveLens, describeLens, profileEnabled } from './lens/resolve';
export type {
  LensImage,
  LensPanelChoice,
  LensPanelState,
  LensResolution,
  MeasuredCa,
} from './lens/resolve';
export {
  correctedShapes,
  previewShapesToRecorded,
  recordedRegionToPreview,
  withoutLensGeometry,
} from './lens/shapes';
export { LENSFUN, lensfunKey } from './lens/lensfun';
export { lensCorrectedPosition } from './lens/model';
export type { LensUniforms } from './lens/model';

// CPU reference (tests, export fallback)
export { developPixel, renderCpu, renderCpuFloat } from './cpu';
export type { RenderSize } from './cpu';
export * as ops from './ops';
export {
  NEIGHBOURHOOD_PARAMS,
  needsNeighbourhood,
  withoutNeighbourhood,
} from './neighbourhood/params';
export { grainSeedFromId } from './color/effects';
export { createMonotoneSpline, isIdentityCurve } from './spline';
export type { Spline } from './spline';

// Image buffers
export { floatToHalf, halfToFloat, quantizeToHalf, toFloat32Samples } from './image';
export type { LinearImageBuffer } from './image';

// Lightroom presets
export {
  applyPreset,
  parsePreset,
  parsePresetLrtemplate,
  parsePresetXmp,
  PresetParseError,
} from './preset';
export type { ParsedPreset, ParseOptions } from './preset';
