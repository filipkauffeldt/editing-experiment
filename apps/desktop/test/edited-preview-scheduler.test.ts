import type { EditParams, Photo, PhotoId, RenderedImage, RetouchOp } from '@ee/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EditedPreviewScheduler,
  type EditedPreviewDeps,
} from '../src/renderer/edited-preview-scheduler';
import { mockPhotos } from '../src/shared/mock';

const [photoA, photoB] = mockPhotos() as [Photo, Photo];

const mosaic: RetouchOp = {
  type: 'mosaic',
  shapes: [{ type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
  blockSizeRel: 0.02,
};

const image = (size: number): RenderedImage => ({
  width: size,
  height: size,
  rgba: new Uint8Array(size * size * 4),
});

interface Harness {
  scheduler: EditedPreviewScheduler;
  params: Map<PhotoId, EditParams>;
  ops: Map<PhotoId, RetouchOp[]>;
  photos: Map<PhotoId, Photo>;
  rendered: { photoId: PhotoId; params: EditParams }[];
  stored: { photoId: PhotoId; revision: number; retouchOps: RetouchOp[] }[];
  errors: unknown[];
  inFlight: { now: number; max: number };
  /** Hold every render until `release` is called. */
  gate: { hold: boolean; release(): void };
}

function harness(overrides: Partial<EditedPreviewDeps> = {}): Harness {
  const photos = new Map<PhotoId, Photo>([
    [photoA.id, photoA],
    [photoB.id, photoB],
  ]);
  const h: Harness = {
    scheduler: undefined as never,
    params: new Map(),
    ops: new Map(),
    photos,
    rendered: [],
    stored: [],
    errors: [],
    inFlight: { now: 0, max: 0 },
    gate: { hold: false, release: () => {} },
  };
  h.scheduler = new EditedPreviewScheduler({
    render: async (photo, params) => {
      h.inFlight.now += 1;
      h.inFlight.max = Math.max(h.inFlight.max, h.inFlight.now);
      h.rendered.push({ photoId: photo.id, params });
      if (h.gate.hold) {
        await new Promise<void>((resolve) => {
          h.gate.release = resolve;
        });
      }
      h.inFlight.now -= 1;
      return { thumb: image(2), preview: image(4) };
    },
    getPhoto: (photoId) => h.photos.get(photoId),
    settle: async () => {},
    getParams: async (photoId) => h.params.get(photoId) ?? {},
    getRetouchOps: (photo) => h.ops.get(photo.id) ?? [],
    store: async (args) => {
      h.stored.push({
        photoId: args.photoId,
        revision: args.revision,
        retouchOps: args.retouchOps,
      });
      return { ...h.photos.get(args.photoId)!, previewStale: false };
    },
    onError: (_photo, error) => h.errors.push(error),
    ...overrides,
  });
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('debounce and coalescing', () => {
  it('renders nothing while edits keep coming, then once after 750 ms of quiet', async () => {
    const h = harness();
    for (let i = 1; i <= 5; i++) {
      h.params.set(photoA.id, { Exposure2012: i / 10 });
      h.scheduler.schedule(photoA.id);
      await advance(500);
    }
    expect(h.rendered).toHaveLength(0);

    await advance(249);
    expect(h.rendered).toHaveLength(0);
    await advance(1);
    expect(h.rendered).toHaveLength(1);
    expect(h.rendered[0]?.params).toEqual({ Exposure2012: 0.5 });
    expect(h.stored).toHaveLength(1);
  });

  it('renders again for a later edit', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.2 });
    h.scheduler.schedule(photoA.id);
    await advance(800);
    h.params.set(photoA.id, { Exposure2012: 0.4 });
    h.scheduler.schedule(photoA.id);
    await advance(800);

    expect(h.rendered.map((r) => r.params)).toEqual([{ Exposure2012: 0.2 }, { Exposure2012: 0.4 }]);
    const [first, second] = h.stored;
    expect(second!.revision).toBeGreaterThan(first!.revision);
  });

  it('sends the retouch ops the pixels were drawn with', async () => {
    const h = harness();
    h.ops.set(photoA.id, [mosaic]);
    h.scheduler.scheduleNow(photoA.id);
    await advance(0);
    expect(h.stored[0]?.retouchOps).toEqual([mosaic]);
  });
});

describe('stale renders', () => {
  it('throws away a render finished after a newer edit and stores only the newer one', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.2 });
    h.gate.hold = true;
    h.scheduler.schedule(photoA.id);
    await advance(750);
    expect(h.rendered).toHaveLength(1);

    // A newer edit lands while the first render is still going.
    h.params.set(photoA.id, { Exposure2012: 0.9 });
    h.scheduler.schedule(photoA.id);
    h.gate.release();
    await advance(0);
    expect(h.stored).toHaveLength(0);

    h.gate.hold = false;
    await advance(750);
    expect(h.rendered).toHaveLength(2);
    expect(h.stored).toHaveLength(1);
    expect(h.rendered[1]?.params).toEqual({ Exposure2012: 0.9 });
  });

  it('keeps revisions growing even when the clock does not move', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.2 });
    h.scheduler.scheduleNow(photoA.id);
    await advance(0);
    h.scheduler.scheduleNow(photoA.id);
    await advance(0);
    expect(h.stored).toHaveLength(2);
    expect(h.stored[1]!.revision).toBeGreaterThan(h.stored[0]!.revision);
  });

  it('tries again when the backend refuses a render because the edits moved on', async () => {
    let refusals = 2;
    const h = harness({
      store: async (args) => ({
        ...photoA,
        id: args.photoId,
        previewStale: refusals-- > 0,
      }),
    });
    h.params.set(photoA.id, { Exposure2012: 0.2 });
    h.scheduler.scheduleNow(photoA.id);
    await advance(0);
    expect(h.rendered).toHaveLength(1);
    await advance(750);
    expect(h.rendered).toHaveLength(2);
    await advance(750);
    expect(h.rendered).toHaveLength(3);
    await advance(5_000);
    expect(h.rendered).toHaveLength(3);
  });

  it('gives up after a few refusals instead of looping', async () => {
    const h = harness({
      store: async (args) => ({ ...photoA, id: args.photoId, previewStale: true }),
    });
    h.params.set(photoA.id, { Exposure2012: 0.2 });
    h.scheduler.scheduleNow(photoA.id);
    await advance(20_000);
    expect(h.rendered).toHaveLength(4);
  });
});

describe('reset', () => {
  it('draws nothing when the edits were removed again before the render', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.5 });
    h.scheduler.schedule(photoA.id);
    h.params.set(photoA.id, {});
    await advance(800);
    expect(h.rendered).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });

  it('treats an as-shot white balance and the process version as no edit', async () => {
    const h = harness();
    h.params.set(photoA.id, { WhiteBalance: 'As Shot', ProcessVersion: '11.0' });
    h.scheduler.scheduleNow(photoA.id);
    await advance(0);
    expect(h.rendered).toHaveLength(0);
  });

  it('still renders a photo that has only a crop, or only a retouch version', async () => {
    const h = harness();
    h.params.set(photoA.id, { crop: { left: 0, top: 0, right: 0.5, bottom: 1, angle: 0 } });
    h.ops.set(photoB.id, [mosaic]);
    h.scheduler.scheduleNow(photoA.id);
    h.scheduler.scheduleNow(photoB.id);
    await advance(0);
    expect(h.stored.map((s) => s.photoId).sort()).toEqual([photoA.id, photoB.id].sort());
  });
});

describe('queue', () => {
  it('keeps a pending photo when the user moves on, and renders it at once when promoted', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.scheduler.schedule(photoA.id);
    await advance(100);
    // The selection moved to another photo; the pending one is not dropped.
    h.scheduler.promote(photoA.id);
    await advance(0);
    expect(h.stored.map((s) => s.photoId)).toEqual([photoA.id]);
  });

  it('renders photos one at a time', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.params.set(photoB.id, { Exposure2012: 0.6 });
    h.gate.hold = true;
    h.scheduler.schedule(photoA.id);
    h.scheduler.schedule(photoB.id);
    await advance(750);
    expect(h.rendered).toHaveLength(1);
    h.gate.release();
    await advance(0);
    expect(h.rendered).toHaveLength(2);
    h.gate.hold = false;
    h.gate.release();
    await advance(0);
    expect(h.inFlight.max).toBe(1);
    expect(h.stored).toHaveLength(2);
  });

  it('puts a retouch commit ahead of waiting edits and background work', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.params.set(photoB.id, { Exposure2012: 0.6 });
    h.gate.hold = true;
    h.scheduler.schedule(photoA.id);
    await advance(750);
    expect(h.rendered).toHaveLength(1);

    h.scheduler.schedule(photoB.id);
    h.scheduler.promote(photoB.id);
    h.scheduler.scheduleNow(photoA.id);
    h.gate.hold = false;
    h.gate.release();
    await advance(0);
    // A's first render was superseded by the commit; the commit (urgent) goes before B (edit).
    expect(h.rendered.map((r) => r.photoId)).toEqual([photoA.id, photoA.id, photoB.id]);
  });

  it('flush runs everything that is waiting and resolves when idle', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.params.set(photoB.id, { Exposure2012: 0.6 });
    h.scheduler.schedule(photoA.id);
    h.scheduler.schedule(photoB.id);
    const done = h.scheduler.flush();
    await advance(0);
    await done;
    expect(h.stored).toHaveLength(2);
  });

  it('dispose cancels what has not started', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.scheduler.schedule(photoA.id);
    h.scheduler.dispose();
    await advance(5_000);
    expect(h.rendered).toHaveLength(0);
  });
});

describe('photos edited before the cache knew (on screen)', () => {
  const stale = (photo: Photo): Photo => ({
    ...photo,
    status: { ...photo.status, edited: true },
    previewStale: true,
  });

  it('renders only photos that are edited and stale', async () => {
    const h = harness();
    h.photos.set(photoA.id, stale(photoA));
    h.photos.set(photoB.id, { ...photoB, status: { ...photoB.status, edited: true } });
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.params.set(photoB.id, { Exposure2012: 0.3 });
    h.scheduler.setVisible([photoA.id, photoB.id]);
    await advance(0);
    expect(h.rendered.map((r) => r.photoId)).toEqual([photoA.id]);
  });

  it('spaces background renders out', async () => {
    const h = harness();
    h.photos.set(photoA.id, stale(photoA));
    h.photos.set(photoB.id, stale(photoB));
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.params.set(photoB.id, { Exposure2012: 0.3 });
    h.scheduler.setVisible([photoA.id, photoB.id]);
    await advance(0);
    expect(h.rendered).toHaveLength(1);
    await advance(100);
    expect(h.rendered).toHaveLength(1);
    await advance(200);
    expect(h.rendered).toHaveLength(2);
  });

  it('does not queue a photo twice, and leaves a failing photo alone for a while', async () => {
    let fail = true;
    const h = harness({
      render: async () => {
        if (fail) throw new Error('no GPU');
        return { thumb: image(2), preview: image(4) };
      },
    });
    h.photos.set(photoA.id, stale(photoA));
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.scheduler.setVisible([photoA.id]);
    h.scheduler.setVisible([photoA.id]);
    await advance(0);
    expect(h.errors).toHaveLength(1);

    h.scheduler.setVisible([photoA.id]);
    await advance(1_000);
    expect(h.errors).toHaveLength(1);

    fail = false;
    await advance(30_000);
    h.scheduler.setVisible([photoA.id]);
    await advance(0);
    expect(h.stored).toHaveLength(1);
  });

  it('does not re-render a photo whose edit is already waiting for its debounce', async () => {
    const h = harness();
    h.photos.set(photoA.id, stale(photoA));
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.scheduler.schedule(photoA.id);
    h.scheduler.setVisible([photoA.id]);
    await advance(749);
    expect(h.rendered).toHaveLength(0);
    await advance(1);
    expect(h.rendered).toHaveLength(1);
  });
});

describe('photos with nothing to draw', () => {
  it('looks at a stale photo without edits once, clears the flag, and leaves it alone while scrolling', async () => {
    let looks = 0;
    let params: EditParams = { ProcessVersion: '11.0' };
    const cleared: PhotoId[] = [];
    const h = harness({
      getParams: async () => {
        looks += 1;
        return params;
      },
      onNoEdits: (photo) => cleared.push(photo.id),
    });
    h.photos.set(photoA.id, {
      ...photoA,
      status: { ...photoA.status, edited: true },
      previewStale: true,
    });
    for (let i = 0; i < 5; i++) {
      h.scheduler.setVisible([photoA.id]);
      h.scheduler.setVisible([]);
      h.scheduler.setSelected(photoA.id);
      await advance(1_000);
    }
    expect(looks).toBe(1);
    expect(cleared).toEqual([photoA.id]);
    expect(h.rendered).toHaveLength(0);

    // A real edit afterwards is drawn as usual.
    params = { Exposure2012: 0.4 };
    h.scheduler.schedule(photoA.id);
    await advance(800);
    expect(h.stored).toHaveLength(1);
  });
});

describe('what is on screen goes first', () => {
  const stale = (photo: Photo, id: string): Photo => ({
    ...photo,
    id: id as PhotoId,
    status: { ...photo.status, edited: true },
    previewStale: true,
  });
  const many = (h: Harness, count: number): PhotoId[] =>
    Array.from({ length: count }, (_, i) => {
      const photo = stale(photoA, `p${i}`);
      h.photos.set(photo.id, photo);
      h.params.set(photo.id, { Exposure2012: 0.3 });
      return photo.id;
    });
  const jobCount = (h: Harness): number =>
    (h.scheduler as unknown as { jobs: Map<PhotoId, unknown> }).jobs.size;

  it('does not queue the photos of a long strip that were only scrolled past', async () => {
    const h = harness();
    const all = many(h, 2000);
    // Scroll the whole strip in windows of 20 frames, faster than anything renders.
    for (let from = 0; from + 20 <= all.length; from += 5) {
      h.scheduler.setVisible(all.slice(from, from + 20));
    }
    expect(jobCount(h)).toBeLessThanOrEqual(21);

    await advance(30_000);
    const last = new Set(all.slice(-20));
    const rendered = h.rendered.map((r) => r.photoId);
    // At most the one render that had already started, and everything now on screen.
    expect(rendered.filter((id) => !last.has(id))).toHaveLength(1);
    expect(new Set(rendered.filter((id) => last.has(id))).size).toBe(20);
    expect(h.stored).toHaveLength(21);
    // Finished jobs are forgotten.
    expect(jobCount(h)).toBe(0);
  });

  it('draws the selected photo first, then the newest frames', async () => {
    const h = harness();
    const [a, b, c, d, e] = many(h, 5) as [PhotoId, PhotoId, PhotoId, PhotoId, PhotoId];
    h.scheduler.setVisible([a, b, c]);
    h.scheduler.setVisible([a, b, c, d, e]);
    h.scheduler.setSelected(c);
    await advance(5_000);
    // `a` was already rendering; then the selected `c`; then the newest first.
    expect(h.rendered.map((r) => r.photoId)).toEqual([a, c, e, d, b]);
  });

  it('puts edits and retouch commits ahead of background work', async () => {
    const h = harness();
    const [a, b] = many(h, 2) as [PhotoId, PhotoId];
    h.gate.hold = true;
    h.scheduler.setVisible([a, b]);
    h.params.set(photoB.id, { Exposure2012: 0.1 });
    h.scheduler.scheduleNow(photoB.id);
    h.gate.hold = false;
    h.gate.release();
    await advance(5_000);
    expect(h.rendered.map((r) => r.photoId)).toEqual([a, photoB.id, b]);
  });

  it('forgets photos that were only edited once', async () => {
    const h = harness();
    h.params.set(photoA.id, { Exposure2012: 0.3 });
    h.scheduler.schedule(photoA.id);
    await advance(1_000);
    expect(h.stored).toHaveLength(1);
    expect(jobCount(h)).toBe(0);
  });
});
