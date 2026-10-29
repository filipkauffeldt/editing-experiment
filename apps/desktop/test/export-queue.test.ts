// @vitest-environment node
import {
  asDestinationId,
  asExportJobId,
  asPhotoId,
  asPresetId,
  type ExportJob,
  type ExportPreset,
  type JobEvent,
  type PhotoId,
} from '@ee/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportQueue } from '../src/jobs/backend/export-queue';
import { defaultExportPreset } from '../src/shared/settings';

const photo = (n: number): PhotoId => asPhotoId(`p${n}`);
const destination = asDestinationId('desk');

const preset = (overrides: Partial<ExportPreset> = {}): ExportPreset => ({
  ...defaultExportPreset(),
  id: asPresetId('preset'),
  name: 'Preset',
  sendTo: [],
  ...overrides,
});

const rendered = { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4).fill(128) };

const renderEvents = (
  events: JobEvent[],
  jobId: ExportJob['id'],
): Extract<JobEvent, { type: 'export.render' }>[] =>
  events.filter(
    (event): event is Extract<JobEvent, { type: 'export.render' }> =>
      event.type === 'export.render' && event.jobId === jobId,
  );

interface Harness {
  queue: ExportQueue;
  events: JobEvent[];
  exported: PhotoId[];
  enqueued: { photoId: PhotoId; path: string; destinations: string[] }[];
  fail: Set<PhotoId>;
  respond(event: Extract<JobEvent, { type: 'export.render' }>): void;
  job(jobId: ExportJob['id']): ExportJob | undefined;
}

function harness(
  options: { file?: string; fail?: PhotoId[]; preset?: Partial<ExportPreset> } = {},
): Harness {
  const events: JobEvent[] = [];
  const exported: PhotoId[] = [];
  const enqueued: Harness['enqueued'] = [];
  const fail = new Set(options.fail ?? []);
  let sequence = 0;
  let request = 0;
  const queue = new ExportQueue({
    ...(options.file === undefined ? {} : { file: options.file }),
    getPreset: () => preset(options.preset),
    exportPhoto: async ({ photoId }) => {
      if (fail.has(photoId)) throw new Error(`could not encode ${photoId}`);
      exported.push(photoId);
      return { path: `/exports/${photoId}.jpg`, fileName: `${photoId}.jpg` };
    },
    enqueue: async ({ photoId, path, destinations }) => {
      enqueued.push({ photoId, path, destinations: [...destinations] });
    },
    emit: (event) => events.push(event),
    newJobId: () => asExportJobId(`job-${++sequence}`),
    newRequestId: () => `req-${++request}`,
  });
  return {
    queue,
    events,
    exported,
    enqueued,
    fail,
    respond: (event) => queue.deliverRender({ ...event, rendered }),
    job: (jobId) => queue.list().find((candidate) => candidate.id === jobId),
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ExportQueue', () => {
  it('renders and exports photos one at a time in order', async () => {
    const test = harness();
    const jobId = test.queue.start({
      photoIds: [photo(1), photo(2), photo(3)],
      presetId: preset().id,
    });

    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(1));
    test.respond(renderEvents(test.events, jobId)[0]!);
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(2));
    test.respond(renderEvents(test.events, jobId)[1]!);
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(3));
    test.respond(renderEvents(test.events, jobId)[2]!);

    await vi.waitFor(() => expect(test.job(jobId)?.state).toBe('done'));
    expect(renderEvents(test.events, jobId).map((event) => event.photoId)).toEqual([
      photo(1),
      photo(2),
      photo(3),
    ]);
    expect(test.exported).toEqual([photo(1), photo(2), photo(3)]);
    expect(test.job(jobId)?.photos.map((progress) => progress.state)).toEqual([
      'done',
      'done',
      'done',
    ]);
  });

  it('cancels the batch and stops asking for renders', async () => {
    const test = harness();
    const jobId = test.queue.start({
      photoIds: [photo(1), photo(2)],
      presetId: preset().id,
      send: [destination],
    });
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(1));
    test.queue.cancel(jobId);

    await vi.waitFor(() => expect(test.job(jobId)?.state).toBe('cancelled'));
    expect(renderEvents(test.events, jobId)).toHaveLength(1);
    expect(test.exported).toEqual([]);
    expect(test.enqueued).toEqual([]);
  });

  it('keeps exported photos and resumes the rest after a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ee-export-queue-'));
    dirs.push(root);
    const file = join(root, 'exports.json');
    const first = harness({ file });
    const jobId = first.queue.start({
      photoIds: [photo(1), photo(2)],
      presetId: preset().id,
    });
    await vi.waitFor(() => expect(renderEvents(first.events, jobId)).toHaveLength(1));
    first.respond(renderEvents(first.events, jobId)[0]!);
    await vi.waitFor(() => expect(renderEvents(first.events, jobId)).toHaveLength(2));
    first.queue.close();

    const resumed = harness({ file });
    const restored = resumed.queue.list()[0]!;
    expect(restored.id).toBe(jobId);
    expect(restored.photos.map((progress) => progress.state)).toEqual(['done', 'queued']);

    resumed.queue.markRendererReady();
    await vi.waitFor(() =>
      expect(renderEvents(resumed.events, jobId).map((event) => event.photoId)).toEqual([photo(2)]),
    );
    resumed.respond(renderEvents(resumed.events, jobId)[0]!);
    await vi.waitFor(() => expect(resumed.job(jobId)?.state).toBe('done'));
    expect(resumed.exported).toEqual([photo(2)]);
  });

  it('fails one photo without stopping the batch and sends only successful exports', async () => {
    const test = harness({ fail: [photo(1)] });
    const jobId = test.queue.start({
      photoIds: [photo(1), photo(2)],
      presetId: preset().id,
      send: [destination],
    });

    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(1));
    test.respond(renderEvents(test.events, jobId)[0]!);
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(2));
    test.respond(renderEvents(test.events, jobId)[1]!);

    await vi.waitFor(() => expect(test.job(jobId)?.state).toBe('failed'));
    expect(test.job(jobId)?.photos.map((progress) => progress.state)).toEqual(['failed', 'done']);
    expect(test.enqueued).toEqual([
      { photoId: photo(2), path: `/exports/${photo(2)}.jpg`, destinations: [destination] },
    ]);
  });

  it('turns a renderer failure into a failed photo, not a failed queue', async () => {
    const test = harness();
    const jobId = test.queue.start({
      photoIds: [photo(1), photo(2)],
      presetId: preset().id,
    });
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(1));
    const request = renderEvents(test.events, jobId)[0]!;
    test.queue.deliverRender({ ...request, error: 'GPU lost' });
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(2));
    test.respond(renderEvents(test.events, jobId)[1]!);

    await vi.waitFor(() => expect(test.job(jobId)?.state).toBe('failed'));
    expect(test.job(jobId)?.photos[0]).toMatchObject({ state: 'failed', error: 'GPU lost' });
    expect(test.job(jobId)?.photos[1]?.state).toBe('done');
  });

  it('forces the top version for sends and send actions, but not for export only', async () => {
    const test = harness({ preset: { version: 'develop' } });
    const jobId = test.queue.start({
      photoIds: [photo(1)],
      presetId: preset().id,
      send: [destination],
    });
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(1));
    expect(renderEvents(test.events, jobId)[0]?.version).toBe('top');
    test.respond(renderEvents(test.events, jobId)[0]!);
    await vi.waitFor(() => expect(test.job(jobId)?.state).toBe('done'));
    expect(test.job(jobId)?.version).toBe('top');

    const forced = test.queue.start({
      photoIds: [photo(2)],
      presetId: preset().id,
      send: [],
      forceTop: true,
    });
    await vi.waitFor(() => expect(renderEvents(test.events, forced)).toHaveLength(1));
    expect(renderEvents(test.events, forced)[0]?.version).toBe('top');
    test.respond(renderEvents(test.events, forced)[0]!);
    await vi.waitFor(() => expect(test.job(forced)?.state).toBe('done'));

    const local = test.queue.start({
      photoIds: [photo(3)],
      presetId: preset().id,
      send: [],
    });
    await vi.waitFor(() => expect(renderEvents(test.events, local)).toHaveLength(1));
    expect(renderEvents(test.events, local)[0]?.version).toBe('develop');
    test.respond(renderEvents(test.events, local)[0]!);
    await vi.waitFor(() => expect(test.job(local)?.state).toBe('done'));
  });

  it('re-emits the pending render request when the renderer comes back', async () => {
    const test = harness();
    const jobId = test.queue.start({
      photoIds: [photo(1)],
      presetId: preset().id,
    });
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(1));
    test.queue.markRendererReady();
    await vi.waitFor(() => expect(renderEvents(test.events, jobId)).toHaveLength(2));
    expect(renderEvents(test.events, jobId)[1]?.requestId).toBe(
      renderEvents(test.events, jobId)[0]?.requestId,
    );
    test.respond(renderEvents(test.events, jobId)[1]!);
    await vi.waitFor(() => expect(test.job(jobId)?.state).toBe('done'));
  });
});
