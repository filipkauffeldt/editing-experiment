import * as ort from 'onnxruntime-node';
import type { Point } from '@ee/contracts';
import type { PixelRect } from '../geometry';

const STRIDES = [8, 16, 32] as const;

export interface FaceCandidate {
  box: PixelRect;
  score: number;
  landmarks: Point[];
}

const sessions = new Map<string, Promise<ort.InferenceSession>>();

function loadSession(modelPath: string): Promise<ort.InferenceSession> {
  let session = sessions.get(modelPath);
  if (!session) {
    session = ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    sessions.set(modelPath, session);
    session.catch(() => sessions.delete(modelPath));
  }
  return session;
}

function padTo32(value: number): number {
  return Math.max(32, Math.ceil(value / 32) * 32);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Build the NCHW float tensor YuNet expects: BGR, 0..255, no mean subtraction
 * (matches OpenCV's `blobFromImage` on a BGR image), zero-padded to a multiple
 * of 32 on the right and bottom.
 */
function buildInput(
  rgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
): { tensor: ort.Tensor; paddedWidth: number; paddedHeight: number } {
  const paddedWidth = padTo32(width);
  const paddedHeight = padTo32(height);
  const plane = paddedWidth * paddedHeight;
  const data = new Float32Array(plane * 3);
  for (let y = 0; y < height; y++) {
    const sourceRow = ((sourceY + y) * sourceWidth + sourceX) * 4;
    const destinationRow = y * paddedWidth;
    for (let x = 0; x < width; x++) {
      const source = sourceRow + x * 4;
      const destination = destinationRow + x;
      data[destination] = rgba[source + 2]!;
      data[plane + destination] = rgba[source + 1]!;
      data[plane * 2 + destination] = rgba[source]!;
    }
  }
  const tensor = new ort.Tensor('float32', data, [1, 3, paddedHeight, paddedWidth]);
  return { tensor, paddedWidth, paddedHeight };
}

/** Decode YuNet's stride-8/16/32 heads into candidates in model-input pixels. */
export function decodeYuNetOutputs(
  outputs: Record<string, ort.Tensor>,
  paddedWidth: number,
  paddedHeight: number,
  scoreThreshold: number,
): FaceCandidate[] {
  const candidates: FaceCandidate[] = [];
  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`]?.data as Float32Array | undefined;
    const obj = outputs[`obj_${stride}`]?.data as Float32Array | undefined;
    const bbox = outputs[`bbox_${stride}`]?.data as Float32Array | undefined;
    const kps = outputs[`kps_${stride}`]?.data as Float32Array | undefined;
    if (!cls || !obj || !bbox || !kps) {
      throw new Error(`YuNet output for stride ${stride} is missing`);
    }
    const cols = Math.floor(paddedWidth / stride);
    const rows = Math.floor(paddedHeight / stride);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        // OpenCV's FaceDetectorYN uses sqrt(cls * obj); clamp both heads first.
        const score = Math.sqrt(clamp01(cls[index]!) * clamp01(obj[index]!));
        if (score < scoreThreshold) continue;
        const centerX = (col + bbox[index * 4]!) * stride;
        const centerY = (row + bbox[index * 4 + 1]!) * stride;
        const width = Math.exp(bbox[index * 4 + 2]!) * stride;
        const height = Math.exp(bbox[index * 4 + 3]!) * stride;
        if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
        const landmarks: Point[] = [];
        for (let point = 0; point < 5; point++) {
          landmarks.push({
            x: (col + kps[index * 10 + point * 2]!) * stride,
            y: (row + kps[index * 10 + point * 2 + 1]!) * stride,
          });
        }
        candidates.push({
          box: {
            x: centerX - width / 2,
            y: centerY - height / 2,
            w: width,
            h: height,
          },
          score,
          landmarks,
        });
      }
    }
  }
  return candidates;
}

/** Run one crop through YuNet. Returned coordinates are relative to the crop. */
export async function runYuNet(
  modelPath: string,
  rgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
  scoreThreshold: number,
): Promise<FaceCandidate[]> {
  const session = await loadSession(modelPath);
  const { tensor, paddedWidth, paddedHeight } = buildInput(
    rgba,
    sourceWidth,
    sourceHeight,
    sourceX,
    sourceY,
    width,
    height,
  );
  const outputs = await session.run({ input: tensor });
  return decodeYuNetOutputs(outputs, paddedWidth, paddedHeight, scoreThreshold);
}
