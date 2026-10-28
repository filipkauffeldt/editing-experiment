import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

function waitForRetryEvent(queue: UploadQueue): Promise<JobEvent> {
  let sawUploading = false;
  return new Promise((resolve) => {
    const off = queue.events.on((event) => {
      if (event.type !== 'upload.state') return;
      if (event.state === 'uploading') sawUploading = true;
      if (sawUploading && event.state === 'queued') {
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

  it('rejects a referenced credential that has no password', async () => {
    const localPath = path.join(dir, 'no-password.jpg');
    await writeFile(localPath, Buffer.alloc(1024, 1));
    queue = new UploadQueue({
      dbPath: path.join(dir, 'no-password.sqlite'),
      hooks: { getSecret: async () => ({}) },
      retryBaseDelayMs: 1,
    });
    await queue.enqueue(photoId, localPath, [ftpDestination(server!.port)]);
    queue.start();
    await queue.waitForIdle();
    expect(queue.list()[0]).toMatchObject({
      state: 'failed',
      attempts: 1,
      error: expect.stringContaining('no password credential'),
    });
  });

  it('uploads anonymously when credentialRef is absent', async () => {
    const anonymous = await startFtpServer({ root: path.join(dir, 'anonymous'), anonymous: true });
    try {
      const localPath = path.join(dir, 'anon.jpg');
      await writeFile(localPath, Buffer.alloc(4096, 3));
      queue = new UploadQueue({ dbPath: path.join(dir, 'anon.sqlite') });
      const destination: FtpDestination = {
        id: asDestinationId('anon-ftp'),
        name: 'Anonymous FTP',
        kind: 'ftp',
        host: '127.0.0.1',
        port: anonymous.port,
        username: '',
        security: 'none',
        remotePathTemplate: 'in/{fileName}',
      };
      await queue.enqueue(photoId, localPath, [destination]);
      queue.start();
      await queue.waitForIdle();
      expect(queue.list()[0]).toMatchObject({ state: 'done' });
      expect(await readFile(path.join(anonymous.root, 'in', 'anon.jpg'))).toEqual(
        Buffer.alloc(4096, 3),
      );
    } finally {
      await anonymous.close();
    }
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
    const files = await readdir(path.dirname(finalPath));
    expect(files.filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('fails without overwriting an existing remote file', async () => {
    const localPath = path.join(dir, 'frame.jpg');
    const contents = Buffer.from('new contents');
    await writeFile(localPath, contents);
    const finalPath = path.join(server!.root, 'photos', 'frame.jpg');
    await mkdir(path.dirname(finalPath), { recursive: true });
    await writeFile(finalPath, 'original remote contents');

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue-exists.sqlite'),
      hooks: hooksWith(server!.password),
      maxAttempts: 5,
      retryBaseDelayMs: 1,
    });
    await queue.enqueue(photoId, localPath, [ftpDestination(server!.port)]);
    queue.start();
    await queue.waitForIdle();

    const [item] = queue.list();
    expect(item?.state).toBe('failed');
    expect(item?.attempts).toBe(1);
    expect(item?.error ?? '').toMatch(/already exists/);
    expect(await readFile(finalPath, 'utf8')).toBe('original remote contents');
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

    const retrying = waitForRetryEvent(queue);
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

  it('does not retry when credentials are missing', async () => {
    const localPath = path.join(dir, 'no-credential.jpg');
    await writeFile(localPath, 'x');

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue-no-credential.sqlite'),
      maxAttempts: 5,
      retryBaseDelayMs: 1,
    });
    await queue.enqueue(photoId, localPath, [ftpDestination(server!.port)]);
    queue.start();
    await queue.waitForIdle();

    const [item] = queue.list();
    expect(item?.state).toBe('failed');
    expect(item?.attempts).toBe(1);
    expect(item?.error ?? '').toMatch(/credential provider/);
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
