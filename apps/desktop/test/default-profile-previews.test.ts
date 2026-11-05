// @vitest-environment node
import {
  asPhotoId,
  asSourceId,
  type EditParams,
  type EventChannel,
  type Photo,
  type RenderedImage,
} from '@ee/contracts';
import { buildDcp } from '@ee/develop-gl/profile/testing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { developVersionId } from '../src/jobs/backend/edit-service';
import { EditedPreviews } from '../src/jobs/backend/edited-previews';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { PreviewCache } from '../src/jobs/backend/previews';
import { ProfileLibrary } from '../src/jobs/backend/profiles';

/**
 * Edited thumbnails and previews are drawn through the default camera profile (Camera Standard)
 * for a photo that names none. They are old when the default changes: a profile folder is added
 * or removed, or the file is replaced. The backend notices, marks the photos `previewStale` and
 * refuses a render that was drawn with another default than the one that applies now.
 */

const M = [0.8, -0.2, -0.1, -0.4, 1.3, 0.1, -0.1, 0.2, 0.7];
const F = [0.7, 0.2, 0.1, 0.3, 0.6, 0.1, 0.0, 0.1, 0.8];
const z6 = { make: 'NIKON CORPORATION', model: 'NIKON Z 6_2' };

const flat = (value: number): RenderedImage => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(value);
  return { width: 16, height: 16, rgba };
};

describe('previews and the default camera profile', () => {
  let root: string;
  let events: { channel: EventChannel; payload: unknown }[];
  let photos: PhotoLibrary;
  let cache: PreviewCache;
  let edited: EditedPreviews;
  let profiles: ProfileLibrary;
  let folders: string[];
  let pending: Promise<void>;
  let profileFolder: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-default-previews-'));
    profileFolder = join(root, 'profiles');
    await mkdir(profileFolder);
    await writeFile(
      join(profileFolder, 'Nikon Z 6_2 Camera Standard.dcp'),
      buildDcp({ name: 'Camera Standard', camera: 'Nikon Z 6_2', color: [M], forward: [F] }),
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    events = [];
    folders = [];
    pending = Promise.resolve();
    const dir = await mkdtemp(join(root, 'case-'));
    photos = new PhotoLibrary(new PhotoIndex(':memory:'), (channel, payload) =>
      events.push({ channel, payload }),
    );
    cache = new PreviewCache(join(dir, 'thumb'), join(dir, 'preview'));
    profiles = new ProfileLibrary({
      folders: () => folders,
      platform: 'linux',
      onCameraProfilesChanged: () => {
        pending = edited.markStaleForDefaultProfile();
      },
    });
    edited = new EditedPreviews(photos, cache, (photo, params) =>
      profiles.defaultKeyForPhoto(photo, params),
    );
  });

  const add = (name: string, fileName: string, params: EditParams): Photo => {
    const id = asPhotoId(name);
    const photo: Photo = {
      id,
      path: join(root, fileName),
      sidecarPath: join(root, `${fileName}.xmp`),
      fileName,
      sourceId: asSourceId('s'),
      camera: z6,
      tagged: false,
      colorClass: 0,
      rating: 0,
      status: {
        ingest: 'done',
        edited: true,
        metadataDiffersFromTemplate: false,
        export: 'none',
        upload: 'none',
      },
      versions: [{ id: developVersionId(id), kind: 'develop', ops: params }],
    };
    photos.add(photo);
    return photo;
  };

  /** What the renderer sends: the key the profile resolution gave for the render. */
  const store = async (photo: Photo, defaultProfile: string | undefined, revision = 1) => {
    const develop = photo.versions[0]?.kind === 'develop' ? photo.versions[0].ops : {};
    return edited.set({
      photoId: photo.id,
      revision,
      retouchOps: [],
      params: develop,
      ...(defaultProfile === undefined ? {} : { defaultProfile }),
      thumb: flat(120),
      preview: flat(120),
    });
  };
  const defaultKey = async (photo: Photo): Promise<string> => {
    const answer = await profiles.resolveFor({ photoId: photo.id }, photo);
    return answer.status === 'ok' ? (answer.defaultKey ?? '') : '';
  };

  it('marks a photo drawn without a default stale when a Camera Standard appears, and redraws it with the new one', async () => {
    const photo = add('a', 'a.NEF', { Exposure2012: 0.3 });
    await profiles.index();
    await pending;
    expect((await store(photo, undefined)).previewStale).toBe(false);
    expect((await cache.readEditedMeta(photo.id))?.defaultProfile).toBeUndefined();

    // A profile folder is added in Settings.
    folders = [profileFolder];
    await profiles.index();
    await pending;
    expect(photos.get(photo.id).previewStale).toBe(true);
    expect(events.some((e) => e.channel === 'photos:updated')).toBe(true);

    // A render still drawn without it (it was in flight) is refused and the photo stays stale.
    expect((await store(photo, undefined, 2)).previewStale).toBe(true);
    // The one drawn with the new default is kept, with its key in the marker.
    const key = await defaultKey(photo);
    expect(key).toMatch(/Nikon Z 6_2 Camera Standard\.dcp\|/);
    expect((await store(photo, key, 3)).previewStale).toBe(false);
    expect((await cache.readEditedMeta(photo.id))?.defaultProfile).toBe(key);

    // Taking the folder away again makes the picture old the other way round.
    folders = [];
    await profiles.index();
    await pending;
    expect(photos.get(photo.id).previewStale).toBe(true);
    expect((await store(photo, undefined, 4)).previewStale).toBe(false);
  });

  it('catches up after a restart: previews drawn before the default existed are stale at the first scan', async () => {
    const photo = add('b', 'b.NEF', { Exposure2012: 0.3 });
    await store(photo, undefined);
    expect(photos.get(photo.id).previewStale).toBeFalsy();
    folders = [profileFolder];
    await profiles.index();
    await pending;
    expect(photos.get(photo.id).previewStale).toBe(true);
  });

  it('leaves photos that do not depend on the default alone', async () => {
    const own = add('own', 'own.NEF', { CameraProfile: 'Camera Standard', Exposure2012: 0.3 });
    const none = add('none', 'none.NEF', { CameraProfileChoice: 'none' });
    const jpeg = add('shot', 'shot.jpg', { Exposure2012: 0.3 });
    const other = add('other', 'other.NEF', { Exposure2012: 0.3 });
    other.camera = { make: 'CANON', model: 'Canon EOS R5' };
    photos.update(other.id, () => other);
    for (const photo of [own, none, jpeg, other]) await store(photo, undefined);
    folders = [profileFolder];
    await profiles.index();
    await pending;
    for (const photo of [own, none, jpeg, other]) {
      expect(photos.get(photo.id).previewStale).toBeFalsy();
    }
  });

  it('does not touch photos when a rescan finds the same files', async () => {
    folders = [profileFolder];
    await profiles.index();
    await pending;
    const photo = add('c', 'c.NEF', { Exposure2012: 0.3 });
    await store(photo, await defaultKey(photo));
    events = [];
    await profiles.index(true);
    await pending;
    expect(photos.get(photo.id).previewStale).toBe(false);
    expect(events).toEqual([]);
  });
});
