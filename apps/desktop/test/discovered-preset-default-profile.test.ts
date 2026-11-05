// @vitest-environment node
import { buildDcp } from '@ee/develop-gl/profile/testing';
import { applyPreset } from '@ee/develop-gl/preset';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PresetFolders } from '../src/jobs/backend/preset-folders';
import { PresetLibrary } from '../src/jobs/backend/preset-library';
import { PresetStore } from '../src/jobs/backend/presets';
import { ProfileLibrary } from '../src/jobs/backend/profiles';

/**
 * A preset found in a preset folder meets the Camera Standard default the same way an imported one
 * does: a profile or look it names wins, one that names nothing leaves the default in place.
 */

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-preset-default-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const M = [0.8, -0.2, -0.1, -0.4, 1.3, 0.1, -0.1, 0.2, 0.7];
const F = [0.7, 0.2, 0.1, 0.3, 0.6, 0.1, 0.0, 0.1, 0.8];
const z6 = { make: 'NIKON CORPORATION', model: 'NIKON Z 6_2' };

const xmp = (uuid: string, attributes: string): string =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PresetType="Normal" crs:UUID="${uuid}" crs:Contrast2012="+10" ${attributes}/></rdf:RDF></x:xmpmeta>`;

async function setup() {
  const root = await tempDir();
  const profiles = join(root, 'CameraProfiles');
  await mkdir(profiles);
  for (const name of ['Camera Standard', 'Camera Flat']) {
    await writeFile(
      join(profiles, `Nikon Z 6_2 ${name}.dcp`),
      buildDcp({ name, camera: 'Nikon Z 6_2', color: [M], forward: [F] }),
    );
  }
  const presetFolder = join(root, 'Settings');
  await mkdir(presetFolder);
  await writeFile(
    join(presetFolder, 'Nothing.xmp'),
    xmp('00000000-0000-4000-8000-000000000001', ''),
  );
  await writeFile(
    join(presetFolder, 'Flat.xmp'),
    xmp('00000000-0000-4000-8000-000000000002', 'crs:CameraProfile="Camera Flat"'),
  );
  await writeFile(
    join(presetFolder, 'Look.xmp'),
    xmp(
      '00000000-0000-4000-8000-000000000003',
      'crs:CameraProfile="Adobe Standard" crs:LookName="Adobe Color" crs:LookUUID="B952C231111CD8E0ECCF14B86BAA7077"',
    ),
  );
  const library = new PresetLibrary(
    new PresetStore(join(root, 'presets')),
    new PresetFolders({ folders: () => [presetFolder], platform: 'linux' }),
  );
  const profileLibrary = new ProfileLibrary({ folders: () => [profiles], platform: 'linux' });
  return { library, profileLibrary };
}

describe('a discovered preset and the Camera Standard default', () => {
  it('leaves the default in place when the preset names no profile', async () => {
    const { library, profileLibrary } = await setup();
    const preset = await library.resolve('00000000-0000-4000-8000-000000000001');
    if (!preset) throw new Error('preset not found');
    const params = applyPreset({}, preset);
    expect(params.CameraProfile).toBeUndefined();
    expect(params.Contrast2012).toBe(10);
    expect(await profileLibrary.defaultKeyFor(params, z6)).toMatch(/Camera Standard\.dcp\|/);
    // It does not undo an explicit "Camera matrix" choice either.
    expect(applyPreset({ CameraProfileChoice: 'none' }, preset).CameraProfileChoice).toBe('none');
  });

  it('takes the profile it names over the default', async () => {
    const { library, profileLibrary } = await setup();
    const preset = await library.resolve('00000000-0000-4000-8000-000000000002');
    if (!preset) throw new Error('preset not found');
    const params = applyPreset({ CameraProfileChoice: 'none' }, preset);
    expect(params.CameraProfile).toBe('Camera Flat');
    expect(params.CameraProfileChoice).toBeUndefined();
    expect(await profileLibrary.defaultKeyFor(params, z6)).toBe('');
    const answer = await profileLibrary.resolve(
      { photoId: 'p' as never, profile: params.CameraProfile },
      z6,
    );
    expect(answer).toMatchObject({ status: 'ok', profile: { camera: { name: 'Camera Flat' } } });
    expect(answer).not.toHaveProperty('defaultKey');
  });

  it('takes a look it names over the default, even when the look cannot be found', async () => {
    const { library, profileLibrary } = await setup();
    const preset = await library.resolve('00000000-0000-4000-8000-000000000003');
    if (!preset) throw new Error('preset not found');
    const params = applyPreset({}, preset);
    expect(params.LookName).toBe('Adobe Color');
    expect(await profileLibrary.defaultKeyFor(params, z6)).toBe('');
    const answer = await profileLibrary.resolve(
      {
        photoId: 'p' as never,
        ...(params.CameraProfile ? { profile: params.CameraProfile } : {}),
        ...(params.LookName ? { lookName: params.LookName } : {}),
        ...(params.LookUUID ? { lookUuid: params.LookUUID } : {}),
      },
      z6,
    );
    // No Adobe Standard or Adobe Color here: missing, never silently the default.
    expect(answer.status).toBe('missing');
  });
});
