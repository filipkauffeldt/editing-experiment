import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asDestinationId, asPhotoId, type FtpDestination, type JobEvent } from '@ee/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testDestination, UploadQueue, type ExportHooks } from '../src/index';
import { startFtpServer, type FtpTestServer } from './helpers/ftp-server';

const photoId = asPhotoId('photo-ftp');

function ftpDestination(port: number, credentialRef = 'cred-ftp'): FtpDestination {
  return {
    id: asDestinationId('dest-ftp'),
    name: 'FTP',
    kind: 'ftp',
    host: '127.0.0.1',
    port,
    username: 'photo',
    credentialRef,
    security: 'none',
    remotePathTemplate: 'photos/{fileName}',
  };
}

function hooksWith(password: string): ExportHooks {
  return { getSecret: async () => ({ password }) };
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

describe('FTP uploads', () => {
  let dir: string;
  let server: FtpTestServer | undefined;
  let queue: UploadQueue | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-ftp-'));
    server = await startFtpServer({ root: path.join(dir, 'server') });
    await mkdir(server!.root, { recursive: true });
  });

  afterEach(async () => {
    await queue?.close();
    queue = undefined;
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads to a temp name, renames it, and creates directories', async () => {
    const localPath = path.join(dir, 'frame.jpg');
    const contents = Buffer.alloc(64 * 1024, 9);
    await writeFile(localPath, contents);

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue.sqlite'),
      hooks: hooksWith(server!.password),
      retryBaseDelayMs: 1,
    });

    const [item] = await queue.enqueue(photoId, localPath, [ftpDestination(server!.port)]);
    queue.start();
    await queue.waitForIdle();

    expect(queue.list()[0]?.state).toBe('done');
    expect(queue.list()[0]?.id).toBe(item?.id);
    const finalPath = path.join(server!.root, 'photos', 'frame.jpg');
    expect(await readFile(finalPath)).toEqual(contents);
    await expect(access(`${finalPath}.part`)).rejects.toThrow();
  });

  it('reports connection test results without leaking the password', async () => {
    const destination = ftpDestination(server!.port);
    const ok = await testDestination(destination, hooksWith(server!.password));
    expect(ok.ok).toBe(true);

    const marker = 'wrong-password-marker-41';
    const bad = await testDestination(destination, hooksWith(marker));
    expect(bad.ok).toBe(false);
    expect(bad.message ?? '').not.toContain(marker);
  });

  it('retries after the server drops the connection mid-transfer', async () => {
    await server!.close();
    server = await startFtpServer({
      root: path.join(dir, 'server-drop'),
      dropAfterBytes: 64 * 1024,
    });
    await mkdir(server!.root, { recursive: true });

    const localPath = path.join(dir, 'large.jpg');
    const contents = Buffer.alloc(1024 * 1024, 3);
    await writeFile(localPath, contents);

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue-drop.sqlite'),
      hooks: hooksWith(server!.password),
      retryBaseDelayMs: 150,
      maxAttempts: 3,
    });

    const retrying = waitForEvent(
      queue,
      (event) =>
        event.type === 'upload.state' && event.state === 'queued' && event.error !== undefined,
    );
    await queue.enqueue(photoId, localPath, [ftpDestination(server!.port)]);
    queue.start();
    await retrying;

    const finalPath = path.join(server!.root, 'photos', 'large.jpg');
    await expect(access(finalPath)).rejects.toThrow();
    expect(server!.dropCount()).toBe(1);

    await queue.waitForIdle();
    expect(queue.list()[0]?.state).toBe('done');
    expect((await stat(finalPath)).size).toBe(contents.length);
    await expect(access(`${finalPath}.part`)).rejects.toThrow();
  });

  it('stores a credential-free error when authentication fails', async () => {
    const marker = 'never-log-this-password';
    const localPath = path.join(dir, 'denied.jpg');
    await writeFile(localPath, 'x');

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue-auth.sqlite'),
      hooks: hooksWith(marker),
      maxAttempts: 1,
      retryBaseDelayMs: 1,
    });
    await queue.enqueue(photoId, localPath, [ftpDestination(server!.port)]);
    queue.start();
    await queue.waitForIdle();

    const [item] = queue.list();
    expect(item?.state).toBe('failed');
    expect(item?.error ?? '').not.toContain(marker);
    expect(item?.error?.length ?? 0).toBeGreaterThan(0);
  });

  it('redacts secrets from errors raised by a connector', async () => {
    const marker = 'secret-in-error-message';
    const localPath = path.join(dir, 'connector.jpg');
    await writeFile(localPath, 'x');

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue-redact.sqlite'),
      hooks: hooksWith(marker),
      maxAttempts: 1,
      retryBaseDelayMs: 1,
      connectorFactory: () => ({
        async upload(): Promise<void> {
          throw new Error(`auth failed with password ${marker}`);
        },
        async test() {
          return { ok: true };
        },
      }),
    });
    await queue.enqueue(photoId, localPath, [ftpDestination(server!.port)]);
    queue.start();
    await queue.waitForIdle();

    const [item] = queue.list();
    expect(item?.state).toBe('failed');
    expect(item?.error).toContain('[redacted]');
    expect(item?.error ?? '').not.toContain(marker);
  });
});
