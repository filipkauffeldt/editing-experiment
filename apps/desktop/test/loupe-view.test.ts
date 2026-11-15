import { asPhotoId, asSourceId, type Photo } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { ImagePreloader, type PreloadImage } from '../src/renderer/image-preloader';
import {
  hasRetouchOps,
  loupeBase,
  loupeFrame,
  loupeUrls,
  neededUrl,
  neighbours,
} from '../src/renderer/loupe-view';

const photo = (id: string, extra: Partial<Photo> = {}): Photo => ({
  id: asPhotoId(id),
  path: `/photos/${id}.NEF`,
  sidecarPath: `/photos/${id}.xmp`,
  fileName: `${id}.NEF`,
  sourceId: asSourceId('s'),
  tagged: false,
  colorClass: 0,
  rating: 0,
  status: {
    ingest: 'done',
    edited: false,
    metadataDiffersFromTemplate: false,
    export: 'none',
    upload: 'none',
  },
  versions: [],
  ...extra,
});

const retouch = (ops: number): Photo['versions'][number] => ({
  id: 'r' as never,
  kind: 'retouch',
  ops: Array.from({ length: ops }, () => ({
    type: 'mosaic' as const,
    shapes: [],
    blockSizeRel: 0.05,
  })),
});

describe('hasRetouchOps', () => {
  it('follows the newest retouch version', () => {
    expect(hasRetouchOps(photo('a'))).toBe(false);
    expect(hasRetouchOps(photo('a', { versions: [retouch(1)] }))).toBe(true);
    expect(hasRetouchOps(photo('a', { versions: [retouch(1), retouch(0)] }))).toBe(false);
    expect(hasRetouchOps(photo('a', { versions: [retouch(0), retouch(2)] }))).toBe(true);
  });
});

describe('loupeFrame', () => {
  const sized = { width: 6064, height: 4040 };
  it('is the camera JPEG’s own size for a photo without retouching', () => {
    expect(
      loupeFrame({
        photo: photo('a', sized),
        full: { width: 6048, height: 4024 },
        preview: { width: 2560, height: 1704 },
      }),
    ).toEqual({ width: 6048, height: 4024 });
  });

  it('falls back to the indexed size, then the preview', () => {
    expect(loupeFrame({ photo: photo('a', sized), full: undefined, preview: undefined })).toEqual({
      width: 6064,
      height: 4040,
    });
    expect(
      loupeFrame({ photo: photo('a'), full: undefined, preview: { width: 2560, height: 1704 } }),
    ).toEqual({ width: 2560, height: 1704 });
  });

  it('gives a retouched photo the camera’s size but its own shape, never the camera JPEG', () => {
    const frame = loupeFrame({
      photo: photo('a', { ...sized, versions: [retouch(1)] }),
      full: { width: 6048, height: 4024 },
      preview: { width: 2560, height: 1280 },
    });
    expect(frame.width).toBeCloseTo(6064);
    expect(frame.width / frame.height).toBeCloseTo(2);
  });
});

describe('loupeBase', () => {
  it('fits the frame in the stage with 16 px around it, centred', () => {
    const base = loupeBase({ width: 1032, height: 532 }, { width: 3000, height: 2000 });
    // 1000 x 500 is available: the height decides, 750 x 500.
    expect(base.scale * 3000).toBeCloseTo(750);
    expect(base.offset.x).toBeCloseTo((1032 - 750) / 2);
    expect(base.offset.y).toBeCloseTo(16);
  });
});

describe('loupeUrls', () => {
  it('puts the revision in the full-size URL of a retouched photo only', () => {
    const plain = photo('a', { previewRevision: 3 });
    expect(loupeUrls(plain)).toEqual({ preview: 'app://preview/a?v=3', full: 'app://full/a' });
    const retouched = photo('a', { previewRevision: 3, versions: [retouch(1)] });
    expect(loupeUrls(retouched).full).toBe('app://full/a?v=3');
  });

  it('needs the preview at Fit and the full-size JPEG when zoomed', () => {
    const a = photo('a');
    expect(neededUrl(a, false)).toBe('app://preview/a');
    expect(neededUrl(a, true)).toBe('app://full/a');
  });
});

describe('neighbours', () => {
  const list = ['a', 'b', 'c', 'd'].map((id) => photo(id));
  it('lists the next photo first, then the previous one', () => {
    expect(neighbours(list, 'b').map((p) => p.id)).toEqual(['c', 'a']);
    expect(neighbours(list, 'a').map((p) => p.id)).toEqual(['b']);
    expect(neighbours(list, 'd').map((p) => p.id)).toEqual(['c']);
    expect(neighbours(list, 'zzz')).toEqual([]);
  });
});

describe('ImagePreloader', () => {
  const make = () => {
    const images: (PreloadImage & { decoded: number })[] = [];
    const preloader = new ImagePreloader(2, () => {
      const image = {
        src: '',
        decoding: 'auto' as const,
        decoded: 0,
        decode() {
          image.decoded += 1;
          return Promise.resolve();
        },
      };
      images.push(image);
      return image;
    });
    return { preloader, images };
  };

  it('fetches and decodes what is wanted, once', () => {
    const { preloader, images } = make();
    preloader.want(['a', 'b']);
    preloader.want(['a', 'b']);
    expect(images.map((image) => image.src)).toEqual(['a', 'b']);
    expect(images.every((image) => image.decoded === 1 && image.decoding === 'async')).toBe(true);
  });

  it('holds at most its limit, nearest first', () => {
    const { preloader } = make();
    preloader.want(['a', 'b', 'c']);
    expect(preloader.urls()).toEqual(['a', 'b']);
  });

  it('drops and cancels what is no longer wanted', () => {
    const { preloader, images } = make();
    preloader.want(['a', 'b']);
    preloader.want(['b', 'c']);
    expect(preloader.urls()).toEqual(['b', 'c']);
    // The dropped image's request is cancelled by clearing its source.
    expect(images[0]!.src).toBe('');
    preloader.keepOnly(['c']);
    expect(preloader.urls()).toEqual(['c']);
    preloader.clear();
    expect(preloader.urls()).toEqual([]);
  });
});
