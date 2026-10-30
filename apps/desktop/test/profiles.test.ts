// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDcp, identityTable } from '@ee/develop-gl/profile/testing';
import { buildLookXmp } from '@ee/develop-gl/profile/testing-look';
import { asPhotoId } from '@ee/contracts';
import { cameraFits, defaultProfileFolders, ProfileLibrary } from '../src/jobs/backend/profiles';

/**
 * The profile library over real folders of synthetic files. Nothing here is an Adobe file: the
 * DCPs and the look are written by the test helpers of `@ee/develop-gl`.
 */

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-profiles-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const M = [0.8, -0.2, -0.1, -0.4, 1.3, 0.1, -0.1, 0.2, 0.7];
const F = [0.7, 0.2, 0.1, 0.3, 0.6, 0.1, 0.0, 0.1, 0.8];

async function makeFolder(): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, 'Adobe Standard'), { recursive: true });
  await mkdir(join(root, 'Camera Matching'), { recursive: true });
  await mkdir(join(root, 'Adobe Raw'), { recursive: true });
  const dcp = (path: string, name: string, camera: string, extra = {}): Promise<void> =>
    writeFile(join(root, path), buildDcp({ name, camera, color: [M], forward: [F], ...extra }));
  await dcp('Adobe Standard/Nikon Z 6_2 Adobe Standard.dcp', 'Adobe Standard', 'Nikon Z 6_2');
  await dcp('Adobe Standard/Nikon Z 9 Adobe Standard.dcp', 'Adobe Standard', 'Nikon Z 9');
  await dcp('Camera Matching/Nikon Z 6_2 Camera Flat.dcp', 'Camera Flat', 'Nikon Z 6_2', {
    hueSat: [identityTable(6, 2, 1)],
  });
  await dcp('Camera Matching/Nikon Z 6_2 Camera Standard.dcp', 'Camera Standard', 'Nikon Z 6_2');
  await writeFile(join(root, 'Adobe Standard/readme.txt'), 'not a profile');
  await writeFile(join(root, 'Adobe Standard/Broken.dcp'), new Uint8Array([1, 2, 3, 4]));
  await writeFile(
    join(root, 'Adobe Raw/Adobe Color.xmp'),
    buildLookXmp({
      name: 'Adobe Color',
      uuid: 'B952C231111CD8E0ECCF14B86BAA7077',
      base: 'Adobe Standard',
      table: identityTable(6, 2, 1),
      supportsAmount: true,
    }),
  );
  // A develop preset has the same extension and must be left alone.
  await writeFile(
    join(root, 'Adobe Raw/Preset.xmp'),
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PresetType="Normal" crs:Contrast2012="10"/></rdf:RDF></x:xmpmeta>',
  );
  // A look that needs an RGB table cannot be rendered and is reported, not listed.
  await writeFile(
    join(root, 'Adobe Raw/Vintage.xmp'),
    buildLookXmp({
      name: 'Vintage 01',
      base: 'Adobe Standard',
      attributes: { 'crs:RGBTable': 'ABCD' },
    }),
  );
  return root;
}

const z6 = { make: 'NIKON CORPORATION', model: 'NIKON Z 6_2' };
const library = (folder: string, extra: string[] = []): ProfileLibrary =>
  new ProfileLibrary({ folders: () => [folder, ...extra], platform: 'linux' });

describe('camera matching', () => {
  it('compares make and model without case, spaces and underscores', () => {
    expect(cameraFits('Nikon Z 6_2', z6)).toBe(true);
    expect(cameraFits('Nikon Z 6 2', z6)).toBe(true);
    expect(cameraFits('Z 6_2', z6)).toBe(true);
    expect(cameraFits('Nikon Z 6', z6)).toBe(false);
    expect(cameraFits('Nikon Z 9', z6)).toBe(false);
    expect(cameraFits('Fujifilm X100F', { make: 'FUJIFILM', model: 'X100F' })).toBe(true);
    expect(cameraFits('', z6)).toBe(true);
    expect(cameraFits('Nikon Z 6_2', undefined)).toBe(false);
  });
});

describe('profile folders', () => {
  it('has Adobe folders on macOS and Windows and none on Linux', () => {
    expect(defaultProfileFolders('darwin', {}, '/Users/a')).toEqual([
      '/Library/Application Support/Adobe/CameraRaw/CameraProfiles',
      '/Users/a/Library/Application Support/Adobe/CameraRaw/CameraProfiles',
    ]);
    const windows = defaultProfileFolders(
      'win32',
      { ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' },
      'C:\\Users\\a',
    );
    expect(windows[0]).toContain('CameraProfiles');
    expect(windows[0]).toContain('ProgramData');
    expect(windows).toHaveLength(2);
    expect(defaultProfileFolders('linux', {}, '/home/a')).toEqual([]);
  });
});

describe('ProfileLibrary', () => {
  it('finds profiles recursively and groups them as Lightroom does', async () => {
    const root = await makeFolder();
    const index = await library(root).index();
    expect(index.folders).toEqual([root]);
    const byName = (name: string) => index.profiles.filter((p) => p.name === name);
    expect(
      byName('Adobe Standard')
        .map((p) => p.camera)
        .sort(),
    ).toEqual(['Nikon Z 6_2', 'Nikon Z 9']);
    expect(byName('Adobe Standard')[0]?.group).toBe('adobe-raw');
    expect(byName('Camera Flat')[0]).toMatchObject({ group: 'camera-matching', kind: 'camera' });
    expect(byName('Adobe Color')[0]).toMatchObject({
      kind: 'look',
      group: 'adobe-raw',
      base: 'Adobe Standard',
      supportsAmount: true,
      uuid: 'B952C231111CD8E0ECCF14B86BAA7077',
    });
    // The preset is ignored; the broken file and the look with an RGB table are reported.
    expect(index.profiles.some((p) => p.name === 'Preset')).toBe(false);
    expect(index.problems.map((p) => p.path.split(/[\\/]/).pop()).sort()).toEqual([
      'Broken.dcp',
      'Vintage.xmp',
    ]);
    expect(index.problems.find((p) => p.path.endsWith('Vintage.xmp'))?.reason).toMatch(/RGB table/);
  });

  it('lists only what fits the photo’s camera, with the looks over its base profile', async () => {
    const lib = library(await makeFolder());
    const listed = await lib.list(z6);
    expect(listed.camera).toBe('NIKON CORPORATION NIKON Z 6_2');
    expect(listed.profiles.map((p) => p.name).sort()).toEqual([
      'Adobe Color',
      'Adobe Standard',
      'Camera Flat',
      'Camera Standard',
    ]);
    expect(listed.profiles.every((p) => p.camera === '' || p.camera === 'Nikon Z 6_2')).toBe(true);
    const other = await lib.list({ make: 'Canon', model: 'Canon EOS R5' });
    expect(other.profiles).toEqual([]);
  });

  it('resolves a camera profile, and a look over it with its amount', async () => {
    const lib = library(await makeFolder());
    const photoId = asPhotoId('p1');
    const plain = await lib.resolve({ photoId, profile: 'Camera Flat' }, z6);
    expect(plain.status).toBe('ok');
    if (plain.status === 'ok') {
      expect(plain.profile.camera.name).toBe('Camera Flat');
      expect(plain.profile.camera.hueSatMaps).toHaveLength(1);
      expect(plain.profile.look).toBeUndefined();
    }
    const look = await lib.resolve(
      { photoId, profile: 'Adobe Standard', lookName: 'Adobe Color', lookAmount: 0.5 },
      z6,
    );
    expect(look.status).toBe('ok');
    if (look.status === 'ok') {
      expect(look.profile.look?.name).toBe('Adobe Color');
      expect(look.profile.amount).toBe(0.5);
      // The Z 6II profile, not the Z 9's.
      expect(look.profile.camera.camera).toBe('Nikon Z 6_2');
    }
    // A look alone names its base.
    const byUuid = await lib.resolve({ photoId, lookUuid: 'B952C231111CD8E0ECCF14B86BAA7077' }, z6);
    expect(byUuid.status).toBe('ok');
    expect(await lib.resolve({ photoId }, z6)).toEqual({ status: 'none' });
  });

  it('says why a profile is missing: another camera, no folder, an unknown look', async () => {
    const lib = library(await makeFolder());
    const photoId = asPhotoId('p1');
    const z8 = { make: 'NIKON CORPORATION', model: 'NIKON Z 8' };
    const noCamera = await lib.resolve({ photoId, profile: 'Adobe Standard' }, z8);
    expect(noCamera).toEqual({
      status: 'missing',
      reason: 'No "Adobe Standard" profile for NIKON CORPORATION NIKON Z 8 in the profile folders.',
    });
    const noLook = await lib.resolve(
      { photoId, profile: 'Adobe Standard', lookName: 'Adobe Landscape' },
      z6,
    );
    expect(noLook).toMatchObject({ status: 'missing' });
    const empty = await new ProfileLibrary({ folders: () => [], platform: 'linux' }).resolve(
      { photoId, profile: 'Adobe Standard' },
      z6,
    );
    expect(empty).toMatchObject({
      status: 'missing',
      reason: expect.stringMatching(/no profile folder/),
    });
  });

  it('rescans when asked and when the folders change', async () => {
    const root = await makeFolder();
    const extra = await tempDir();
    let folders: string[] = [];
    const lib = new ProfileLibrary({ folders: () => [root, ...folders], platform: 'linux' });
    const before = (await lib.index()).profiles.length;
    await writeFile(
      join(extra, 'New.dcp'),
      buildDcp({ name: 'New One', camera: 'Nikon Z 6_2', color: [M] }),
    );
    expect((await lib.index()).profiles).toHaveLength(before);
    folders = [extra];
    expect((await lib.index()).profiles).toHaveLength(before + 1);
    expect((await lib.index(true)).profiles).toHaveLength(before + 1);
  });

  it('survives a folder that does not exist', async () => {
    const lib = library(join(await tempDir(), 'missing'));
    const index = await lib.index();
    expect(index).toEqual({ profiles: [], problems: [], folders: [] });
  });
});
