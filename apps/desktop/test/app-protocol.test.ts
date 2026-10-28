import { appUrl, asPhotoId } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { resolveAppRequest } from '../src/shared/app-protocol';
import { mockPhotos } from '../src/shared/mock';

describe('resolveAppRequest', () => {
  it('serves a generated SVG for mock thumbs and previews', () => {
    const [photo] = mockPhotos();
    if (!photo) throw new Error('no mock photos');

    const thumb = resolveAppRequest(appUrl.thumb(photo.id), { mock: true });
    const preview = resolveAppRequest(appUrl.preview(photo.id), { mock: true });

    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/svg+xml');
    expect(String(thumb.body)).toContain('<svg');
    expect(String(thumb.body)).toContain('width="240"');
    expect(String(preview.body)).toContain('width="1200"');
  });

  it('answers 404 for an unknown mock photo and for unknown resource kinds', () => {
    expect(resolveAppRequest(appUrl.thumb(asPhotoId('nope')), { mock: true }).status).toBe(404);
    expect(resolveAppRequest('app://bogus/mock-01', { mock: true }).status).toBe(404);
  });

  it('serves a linear f32 image in mock mode and 501 outside it', () => {
    const id = asPhotoId('mock-01');
    expect(resolveAppRequest(appUrl.thumb(id), { mock: false }).status).toBe(501);
    const linear = resolveAppRequest(appUrl.linear(id, 1600), { mock: true });
    expect(linear.status).toBe(200);
    const header = JSON.parse(linear.headers['x-ee-linear-image']!);
    expect(header).toMatchObject({ sampleType: 'f32', width: 1600 });
    expect((linear.body as Uint8Array).byteLength).toBe(header.width * header.height * 16);
  });

  it('decodes ids that were percent-encoded by appUrl', () => {
    const response = resolveAppRequest(appUrl.thumb(asPhotoId('a b')), { mock: false });
    expect(String(response.body)).not.toContain('%20');
  });
});
