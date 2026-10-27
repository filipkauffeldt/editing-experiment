import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  asDestinationId,
  asPhotoId,
  type Destination,
  type FolderDestination,
  type JobEvent,
  type UploadItem,
} from '@ee/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadQueue } from '../src/index';
import type { ConnectorFactory, UploadRequest } from '../src/upload/types';

const photoId = asPhotoId('photo-queue');

function folderDestination(
  id: string,
  directory: string,
  template = '{fileName}',
): FolderDestination {
  return {
    id: asDestinationId(id),
    name: id,
    kind: 'folder',
    path: directory,
    remotePathTemplate: template,
  };
}

function factoryFor(upload: (request: UploadRequest) => Promise<void>): ConnectorFactory {
  return () => ({
    upload,
    test: async () => ({ ok: true, message: 'ok' }),
  });
}

function waitForEvent(
  queue: UploadQueue,
  predicate: (event: JobEvent) => boolean,
): Promise<JobEvent> {
  return new Promise((resolve) => {
    const off = queue.events.on((event) => {
      if (predicate(event)) {
        off();
        resolve(event);
      }
    });
  });
}

function requireItem(items: UploadItem[], id: string): UploadItem {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`missing upload ${id}`);
  return item;
}

describe('UploadQueue', () => {
  let dir: string;
  let dbPath: string;
  const queues: UploadQueue[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-queue-'));
    dbPath = path.join(dir, 'queue.sqlite');
  });

  afterEach(async () => {
    for (const queue of queues.splice(0)) await queue.close();
    await rm(dir, { recursive: true, force: true });
  });

  function queue(options: Partial<ConstructorParameters<typeof UploadQueue>[0]> = {}): UploadQueue {
    const created = new UploadQueue({ dbPath, ...options });
    queues.push(created);
    return created;
  }

  async function localFile(name: string, size = 32): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, Buffer.alloc(size, 7));
    return file;
  }

  it('uploads to a folder destination and emits state/progress events', async () => {
    const destinationDir = path.join(dir, 'delivered');
    const localPath = await localFile('frame.jpg', 4096);
    const destination = folderDestination('dest-folder', destinationDir, 'incoming/{fileName}');
    const queueInstance = queue();
    const events: JobEvent[] = [];
    queueInstance.events.on((event) => events.push(event));

    const uploading = waitForEvent(
      queueInstance,
      (event) => event.type === 'upload.state' && event.state === 'uploading',
    );
    const [item] = await queueInstance.enqueue(photoId, localPath, [destination]);
    queueInstance.start();
    await uploading;
    await queueInstance.waitForIdle();

    const finalPath = path.join(destinationDir, 'incoming', 'frame.jpg');
    await expect(access(finalPath)).resolves.toBeUndefined();
    const [listed] = queueInstance.list();
    expect(listed?.id).toBe(item?.id);
    expect(listed?.state).toBe('done');
    expect(listed?.bytesSent).toBe(4096);
    expect(listed?.bytesTotal).toBe(4096);

    const states = events
      .filter((event) => event.type === 'upload.state')
      .map((event) => (event.type === 'upload.state' ? event.state : ''));
    expect(states).toEqual(['queued', 'uploading', 'done']);
    expect(events.some((event) => event.type === 'upload.progress')).toBe(true);
    expect(await readdir(path.join(destinationDir, 'incoming'))).toEqual(['frame.jpg']);
  });

  it('expands path templates per destination', async () => {
    const destinationDir = path.join(dir, 'expanded');
    const localPath = await localFile('shot.jpg');
    const destination = folderDestination(
      'dest-template',
      destinationDir,
      '{date}/{filenamebase}-{photoId}.jpg',
    );
    const queueInstance = queue();
    const [item] = await queueInstance.enqueue(photoId, localPath, [destination]);
    expect(item?.remotePath).toMatch(/^\d{4}-\d{2}-\d{2}\/shot-photo-queue\.jpg$/);
  });

  it('survives a restart and requeues rows left uploading', async () => {
    const destinationDir = path.join(dir, 'restart');
    const localPath = await localFile('restart.jpg', 1024);
    const destination = folderDestination('dest-restart', destinationDir);

    const blocked = queue({
      connectorFactory: factoryFor(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    });
    const uploading = waitForEvent(
      blocked,
      (event) => event.type === 'upload.state' && event.state === 'uploading',
    );
    const [item] = await blocked.enqueue(photoId, localPath, [destination]);
    blocked.start();
    await uploading;
    await blocked.close();

    const resumed = queue();
    const resumedItem = requireItem(resumed.list(), item!.id);
    expect(resumedItem.state).toBe('queued');

    resumed.start();
    await resumed.waitForIdle();
    expect(requireItem(resumed.list(), item!.id).state).toBe('done');
    await expect(access(path.join(destinationDir, 'restart.jpg'))).resolves.toBeUndefined();
  });

  it('cancels an in-flight upload without publishing a file', async () => {
    const destinationDir = path.join(dir, 'cancelled');
    const localPath = await localFile('cancel.jpg');
    const destination = folderDestination('dest-cancel', destinationDir);
    const queueInstance = queue({
      connectorFactory: factoryFor(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    });

    const uploading = waitForEvent(
      queueInstance,
      (event) => event.type === 'upload.state' && event.state === 'uploading',
    );
    const [item] = await queueInstance.enqueue(photoId, localPath, [destination]);
    queueInstance.start();
    await uploading;

    queueInstance.cancel(item!.id);
    await queueInstance.waitForIdle();
    expect(requireItem(queueInstance.list(), item!.id).state).toBe('cancelled');
    await expect(access(destinationDir)).rejects.toThrow();
  });

  it('retries with backoff and succeeds', async () => {
    const localPath = await localFile('retry.jpg');
    const destination = folderDestination('dest-retry', path.join(dir, 'retry'));
    let attempts = 0;
    const queueInstance = queue({
      retryBaseDelayMs: 1,
      maxAttempts: 5,
      connectorFactory: factoryFor(async () => {
        attempts++;
        if (attempts < 3) throw new Error('temporary failure');
      }),
    });

    const [item] = await queueInstance.enqueue(photoId, localPath, [destination]);
    queueInstance.start();
    await queueInstance.waitForIdle();
    const listed = requireItem(queueInstance.list(), item!.id);
    expect(attempts).toBe(3);
    expect(listed.state).toBe('done');
    expect(listed.attempts).toBe(3);
  });

  it('marks the item failed after maxAttempts and allows a manual retry', async () => {
    const localPath = await localFile('failed.jpg');
    const destination = folderDestination('dest-failed', path.join(dir, 'failed'));
    let fail = true;
    let attempts = 0;
    const queueInstance = queue({
      retryBaseDelayMs: 1,
      maxAttempts: 2,
      connectorFactory: factoryFor(async () => {
        attempts++;
        if (fail) throw new Error('permanent failure');
      }),
    });

    const [item] = await queueInstance.enqueue(photoId, localPath, [destination]);
    queueInstance.start();
    await queueInstance.waitForIdle();
    let listed = requireItem(queueInstance.list(), item!.id);
    expect(listed.state).toBe('failed');
    expect(listed.attempts).toBe(2);
    expect(listed.error).toBe('permanent failure');

    fail = false;
    queueInstance.retry(item!.id);
    await queueInstance.waitForIdle();
    listed = requireItem(queueInstance.list(), item!.id);
    expect(listed.state).toBe('done');
    expect(attempts).toBe(3);
  });

  it('limits concurrency per destination but runs destinations in parallel', async () => {
    const destinations: Destination[] = [
      folderDestination('dest-a', path.join(dir, 'a')),
      folderDestination('dest-b', path.join(dir, 'b')),
    ];
    const active = new Map<string, number>();
    let maxPerDestination = 0;
    let maxTotal = 0;
    let total = 0;
    const queueInstance = queue({
      concurrencyPerDestination: 2,
      connectorFactory: factoryFor(async (request) => {
        total++;
        maxTotal = Math.max(maxTotal, total);
        const id = request.destination.id;
        const next = (active.get(id) ?? 0) + 1;
        active.set(id, next);
        maxPerDestination = Math.max(maxPerDestination, next);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active.set(id, (active.get(id) ?? 1) - 1);
        total--;
      }),
    });

    for (let index = 0; index < 6; index++) {
      const localPath = await localFile(`concurrent-${index}.jpg`, 8);
      const destination = destinations[index % destinations.length]!;
      await queueInstance.enqueue(photoId, localPath, [destination]);
    }
    queueInstance.start();
    await queueInstance.waitForIdle();

    expect(maxPerDestination).toBe(2);
    expect(maxTotal).toBeGreaterThan(2);
    expect(queueInstance.list().every((item) => item.state === 'done')).toBe(true);
  });

  it('rejects unknown ids', () => {
    const queueInstance = queue();
    expect(() => queueInstance.cancel('missing' as never)).toThrowError(/does not exist/);
    expect(() => queueInstance.retry('missing' as never)).toThrowError(/does not exist/);
  });

  it('validates destination templates before enqueueing', async () => {
    const localPath = await localFile('template.jpg');
    const queueInstance = queue();
    const escape = folderDestination('dest-escape', path.join(dir, 'escape'), '../outside.jpg');
    await expect(queueInstance.enqueue(photoId, localPath, [escape])).rejects.toMatchObject({
      code: 'invalid_path',
    });
    expect(queueInstance.list()).toEqual([]);
  });

  it('keeps waiting rows across a restart', async () => {
    const destination = folderDestination('dest-wait', path.join(dir, 'wait'));
    const localPath = await localFile('wait.jpg');
    const first = queue();
    const [item] = await first.enqueue(photoId, localPath, [destination]);
    await first.close();

    const second = queue();
    expect(requireItem(second.list(), item!.id).state).toBe('queued');
  });

  it('closes the database and refuses new work', async () => {
    const queueInstance = queue();
    await queueInstance.close();
    await expect(
      queueInstance.enqueue(photoId, await localFile('closed.jpg'), [
        folderDestination('dest-closed', path.join(dir, 'closed')),
      ]),
    ).rejects.toMatchObject({ code: 'upload_invalid_state' });
  });
});
