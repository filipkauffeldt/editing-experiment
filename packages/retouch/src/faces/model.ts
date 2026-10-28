import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const YUNET_MODEL_FILE = 'face_detection_yunet_2026may.onnx';

/**
 * Model location used when `detectFaces` is not given one. Bundled builds must
 * copy the model or set `EE_YUNET_MODEL_PATH`; the source-tree default points
 * at the gitignored fixtures directory.
 */
export function defaultModelPath(): string {
  const configured = process.env['EE_YUNET_MODEL_PATH'];
  if (configured) return configured;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../../fixtures/models', YUNET_MODEL_FILE);
}
