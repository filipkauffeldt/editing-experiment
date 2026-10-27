import { asPhotoId, asSourceId, asVersionId, type Photo, type PhotoId } from '@ee/contracts';

/** Aspect ratio of every generated image (3:2, like a full-frame camera). */
const MOCK_WIDTH = 3;
const MOCK_HEIGHT = 2;

const MOCK_SOURCE = asSourceId('mock-card');

/** Scenes differ in hue so the film strip is easy to tell apart in screenshots. */
const HUES = [212, 28, 140, 275, 350, 48, 190, 95];

const FILE_COUNT = HUES.length;

/** A fixed set of placeholder photos; deterministic so screenshots are stable. */
export function mockPhotos(): Photo[] {
  return Array.from({ length: FILE_COUNT }, (_, index): Photo => {
    const n = index + 1;
    const fileName = `DSC_${String(n).padStart(4, '0')}.NEF`;
    const path = `/mock/card/${fileName}`;
    return {
      id: mockPhotoId(n),
      path,
      sidecarPath: path.replace(/\.NEF$/, '.xmp'),
      fileName,
      captureTime: `2026-10-24T14:${String(10 + n).padStart(2, '0')}:07`,
      camera: { make: 'NIKON CORPORATION', model: 'NIKON Z 9', lens: 'NIKKOR Z 70-200mm f/2.8' },
      width: 8256,
      height: 5504,
      sourceId: MOCK_SOURCE,
      status: {
        ingest: 'done',
        edited: n === 2 || n === 3,
        metadataDiffersFromTemplate: n === 4,
        export: n === 1 ? 'done' : 'none',
        upload: n === 1 ? 'done' : n === 2 ? 'queued' : 'none',
      },
      versions: [{ id: asVersionId(`mock-${n}-develop`), kind: 'develop', ops: {} }],
    };
  });
}

/** Id of the n-th (1-based) mock photo. */
export function mockPhotoId(n: number): PhotoId {
  return asPhotoId(`mock-${String(n).padStart(2, '0')}`);
}

/**
 * Placeholder image for a mock photo as SVG: sky/ground gradient, a few
 * silhouettes with round heads (so there is something to detect and pixelate
 * later) and the photo number. Returns `undefined` for ids that are not mock photos.
 */
export function mockImageSvg(photoId: string, size: { width: number }): string | undefined {
  const match = /^mock-(\d+)$/.exec(photoId);
  if (!match) return undefined;
  const n = Number(match[1]);
  const hue = HUES[(n - 1) % HUES.length] ?? 0;
  const width = size.width;
  const height = Math.round((width * MOCK_HEIGHT) / MOCK_WIDTH);
  const people = [0.3, 0.5, 0.7].map((x, i) => {
    const cx = Math.round(width * (x + ((n + i) % 3) * 0.02));
    const headR = Math.round(width * 0.045);
    const top = Math.round(height * 0.5);
    return (
      `<circle cx="${cx}" cy="${top}" r="${headR}" fill="hsl(${hue} 25% 22%)"/>` +
      `<rect x="${cx - headR * 1.4}" y="${top + headR * 1.1}" width="${headR * 2.8}" ` +
      `height="${height * 0.4}" rx="${headR}" fill="hsl(${hue} 25% 22%)"/>`
    );
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 55% 62%)"/>` +
    `<stop offset="0.62" stop-color="hsl(${hue} 45% 38%)"/>` +
    `<stop offset="0.62" stop-color="hsl(${hue} 30% 26%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue} 30% 14%)"/></linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#g)"/>` +
    people.join('') +
    `<text x="${width * 0.04}" y="${height * 0.14}" font-family="sans-serif" ` +
    `font-size="${Math.round(width * 0.07)}" font-weight="700" fill="white" fill-opacity="0.85">${n}</text>` +
    `</svg>`
  );
}
