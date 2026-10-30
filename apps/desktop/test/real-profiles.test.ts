// @vitest-environment node
import { decodeLinear } from '@ee/core';
import { renderCpu } from '@ee/develop-gl';
import { ExifToolService } from '@ee/metadata';
import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { ProfileLibrary } from '../src/jobs/backend/profiles';
import { sampleNefs } from './helpers/fixtures';

/**
 * Optional check against the user's own Adobe profiles: set `EE_PROFILE_DIR` to a folder with
 * Adobe's `CameraProfiles` and `EE_SAMPLE_NEF_DIR` to a folder with NEFs. A Z 6 NEF is rendered
 * with Adobe Standard (read only: nothing is written or copied) and must differ from the camera
 * matrix render, with sane brightness. Skipped when either is unset.
 */

const profileDir = process.env.EE_PROFILE_DIR;
const nef = sampleNefs().find((file) => /z ?6/i.test(file)) ?? sampleNefs()[0];

describe.skipIf(!profileDir || !existsSync(profileDir) || nef === undefined)(
  'Adobe Standard from EE_PROFILE_DIR',
  () => {
    const exiftool = new ExifToolService();
    afterAll(() => exiftool.close());

    it('loads for the camera of the sample NEF and renders it', async () => {
      const library = new ProfileLibrary({ folders: () => [profileDir ?? ''], platform: 'linux' });
      const tags = await exiftool.read(nef ?? '');
      const camera = {
        make: String(tags['IFD0:Make'] ?? ''),
        model: String(tags['IFD0:Model'] ?? ''),
      };
      const listed = await library.list(camera);
      expect(listed.profiles.length, `profiles for ${camera.model}`).toBeGreaterThan(0);

      const resolution = await library.resolve(
        { photoId: 'sample' as never, profile: 'Adobe Standard' },
        camera,
      );
      expect(resolution.status, JSON.stringify(resolution)).toBe('ok');
      if (resolution.status !== 'ok') return;

      const linear = await decodeLinear(nef ?? '', { maxEdge: 900, sampleType: 'f32' });
      const plain = renderCpu(linear.header, linear.data, {});
      const profiled = renderCpu(linear.header, linear.data, {}, undefined, {
        profile: resolution.profile,
      });
      const mean = (rgba: Uint8Array): number => {
        let sum = 0;
        for (let i = 0; i < rgba.length; i += 4) sum += (rgba[i + 1] ?? 0) / 255;
        return sum / (rgba.length / 4);
      };
      expect(mean(profiled)).toBeGreaterThan(0.05);
      expect(mean(profiled)).toBeLessThan(0.95);
      let diff = 0;
      for (let i = 0; i < plain.length; i++) diff += Math.abs((plain[i] ?? 0) - (profiled[i] ?? 0));
      expect(diff / plain.length).toBeGreaterThan(0.5);
    }, 120_000);
  },
);
