import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findYuNetModel } from '../src/jobs/backend/faces';

const MODEL = 'face_detection_yunet_2026may.onnx';
type WithResources = { resourcesPath?: string };

describe('findYuNetModel in a packaged app', () => {
  let root: string;
  const originalResources = (process as WithResources).resourcesPath;
  const originalEnv = process.env['EE_YUNET_MODEL_PATH'];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ee-model-'));
    delete process.env['EE_YUNET_MODEL_PATH'];
  });
  afterEach(() => {
    (process as WithResources).resourcesPath = originalResources;
    if (originalEnv === undefined) delete process.env['EE_YUNET_MODEL_PATH'];
    else process.env['EE_YUNET_MODEL_PATH'] = originalEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the model in resources/models', () => {
    mkdirSync(join(root, 'resources', 'models'), { recursive: true });
    writeFileSync(join(root, 'resources', 'models', MODEL), 'onnx');
    (process as WithResources).resourcesPath = join(root, 'resources');
    // The search from the source tree is pointed at an empty folder, so only resources can answer.
    expect(findYuNetModel(join(root, 'nowhere'))).toBe(join(root, 'resources', 'models', MODEL));
  });

  it('lets EE_YUNET_MODEL_PATH win over the packaged model', () => {
    mkdirSync(join(root, 'resources', 'models'), { recursive: true });
    writeFileSync(join(root, 'resources', 'models', MODEL), 'onnx');
    (process as WithResources).resourcesPath = join(root, 'resources');
    process.env['EE_YUNET_MODEL_PATH'] = '/somewhere/else.onnx';
    expect(findYuNetModel(root)).toBe('/somewhere/else.onnx');
  });

  it('does not stop at a resources folder without the model, as in a development run', () => {
    (process as WithResources).resourcesPath = join(root, 'electron-dist-resources');
    mkdirSync(join(root, 'repo', 'fixtures', 'models'), { recursive: true });
    writeFileSync(join(root, 'repo', 'fixtures', 'models', MODEL), 'onnx');
    expect(findYuNetModel(join(root, 'repo', 'apps', 'desktop'))).toBe(
      join(root, 'repo', 'fixtures', 'models', MODEL),
    );
  });
});
