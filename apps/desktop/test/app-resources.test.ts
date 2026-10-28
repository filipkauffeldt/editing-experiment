// @vitest-environment node
import { appUrl, asPhotoId } from '@ee/contracts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppResources } from '../src/jobs/backend/app-resources';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { PreviewCache } from '../src/jobs/backend/previews';

describe('AppResources id validation', () => {
  let root: string;
  let apps: AppResources;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-apps-'));
    const cache = join(root, 'cache');
    await mkdir(join(cache, 'thumb'), { recursive: true });
    await mkdir(join(cache, 'preview'), { recursive: true });
    await writeFile(join(cache, 'thumb', 'good-id.jpg'), 'jpeg');
    // Files a traversal would reach: one level above the thumb folder, and a secret outside the cache.
    await writeFile(join(cache, 'escape.jpg'), 'escaped');
    await writeFile(join(root, 'secret.jpg'), 'secret');
    const previews = new PreviewCache(join(cache, 'thumb'), join(cache, 'preview'));
    apps = new AppResources({
      photos: new PhotoLibrary(new PhotoIndex(':memory:'), () => {}),
      previews,
      linearDir: join(cache, 'linear'),
    });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('serves a well-formed id', async () => {
    const response = await apps.resolve(appUrl.thumb(asPhotoId('good-id')));
    expect(response.status).toBe(200);
    expect(response.file).toBe(join(root, 'cache', 'thumb', 'good-id.jpg'));
  });

  it.each([
    ['dot-dot with an encoded slash', 'app://thumb/..%2Fescape'],
    ['nested dot-dot', 'app://thumb/..%2F..%2Fsecret'],
    ['an encoded backslash', 'app://thumb/..%5Cescape'],
    ['an absolute path', `app://thumb/${encodeURIComponent('/tmp/secret')}`],
    ['an encoded absolute path to a real file', 'app://preview/%2Fetc%2Fpasswd'],
    ['a double-encoded traversal', 'app://thumb/..%252Fescape'],
    ['a dot id', 'app://thumb/%2E%2E'],
    ['an empty id', 'app://thumb/'],
    ['a null byte', 'app://thumb/good-id%00.jpg'],
  ])('rejects %s with 400', async (_name, url) => {
    for (const kind of ['thumb', 'preview', 'linear']) {
      const response = await apps.resolve(
        url.replace('://thumb/', `://${kind}/`).replace('://preview/', `://${kind}/`),
      );
      expect(response.status, `${kind} ${url}`).toBe(400);
      expect(response.file).toBeUndefined();
    }
  });

  it('answers 400 for a malformed percent-escape instead of throwing', async () => {
    expect((await apps.resolve('app://thumb/%E0%A4%A')).status).toBe(400);
  });

  it('still answers 404 for a well-formed id that is not cached', async () => {
    expect((await apps.resolve(appUrl.thumb(asPhotoId('unknown')))).status).toBe(404);
  });
});
