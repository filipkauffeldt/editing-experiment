import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asDestinationId, asPhotoId, type JobEvent, type SftpDestination } from '@ee/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeHostKeyFingerprint,
  testDestination,
  UploadQueue,
  type ExportHooks,
} from '../src/index';
import { startSftpServer, type SftpTestServer } from './helpers/sftp-server';

const photoId = asPhotoId('photo-sftp');

function sftpDestination(
  port: number,
  options: { credentialRef?: string; hostKeyFingerprint?: string } = {},
): SftpDestination {
  return {
    id: asDestinationId('dest-sftp'),
    name: 'SFTP',
    kind: 'sftp',
    host: '127.0.0.1',
    port,
    username: 'photo',
    credentialRef: options.credentialRef ?? 'cred-sftp',
    remotePathTemplate: 'inbox/{fileName}',
    ...(options.hostKeyFingerprint === undefined
      ? {}
      : { hostKeyFingerprint: options.hostKeyFingerprint }),
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

describe('SFTP uploads', () => {
  let dir: string;
  let server: SftpTestServer;
  let queue: UploadQueue | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-sftp-'));
    server = await startSftpServer({ root: path.join(dir, 'server') });
  });

  afterEach(async () => {
    await queue?.close();
    queue = undefined;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads with a pinned host key fingerprint', async () => {
    const localPath = path.join(dir, 'frame.jpg');
    const contents = Buffer.alloc(96 * 1024, 5);
    await writeFile(localPath, contents);

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue.sqlite'),
      hooks: hooksWith(server.password),
      retryBaseDelayMs: 1,
    });

    await queue.enqueue(photoId, localPath, [
      sftpDestination(server.port, { hostKeyFingerprint: server.fingerprint }),
    ]);
    queue.start();
    await queue.waitForIdle();

    expect(queue.list()[0]?.state).toBe('done');
    const finalPath = path.join(server.root, 'inbox', 'frame.jpg');
    expect(await readFile(finalPath)).toEqual(contents);
    await expect(access(`${finalPath}.part`)).rejects.toThrow();
  });

  it('trusts the host key on first use and returns its fingerprint', async () => {
    const destination = sftpDestination(server.port);
    const result = await testDestination(destination, hooksWith(server.password));
    expect(result.ok).toBe(true);
    expect(result.hostKeyFingerprint).toBe(server.fingerprint);
  });

  it('rejects a mismatched pinned fingerprint', async () => {
    const wrong = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const result = await testDestination(
      sftpDestination(server.port, { hostKeyFingerprint: wrong }),
      hooksWith(server.password),
    );
    expect(result.ok).toBe(false);
    expect(result.message ?? '').not.toContain(server.password);
  });

  it('retries after the server drops the connection mid-transfer', async () => {
    await server.close();
    server = await startSftpServer({
      root: path.join(dir, 'server-drop'),
      dropAfterBytes: 48 * 1024,
    });

    const localPath = path.join(dir, 'large.jpg');
    const contents = Buffer.alloc(1024 * 1024, 6);
    await writeFile(localPath, contents);

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue-drop.sqlite'),
      hooks: hooksWith(server.password),
      retryBaseDelayMs: 150,
      maxAttempts: 3,
    });

    const retrying = waitForRetryEvent(queue);
    await queue.enqueue(photoId, localPath, [
      sftpDestination(server.port, { hostKeyFingerprint: server.fingerprint }),
    ]);
    queue.start();
    await retrying;

    const finalPath = path.join(server.root, 'inbox', 'large.jpg');
    await expect(access(finalPath)).rejects.toThrow();
    expect(server.dropCount()).toBe(1);

    await queue.waitForIdle();
    expect(queue.list()[0]?.state).toBe('done');
    expect((await stat(finalPath)).size).toBe(contents.length);
    await expect(access(`${finalPath}.part`)).rejects.toThrow();
  });

  it('normalizes fingerprints for comparison', () => {
    expect(normalizeHostKeyFingerprint(`  ${server.fingerprint}=  `)).toBe(server.fingerprint);
  });

  it('does not include the password in failure messages', async () => {
    const marker = 'sftp-wrong-password-marker';
    const localPath = path.join(dir, 'denied.jpg');
    await writeFile(localPath, 'x');

    queue = new UploadQueue({
      dbPath: path.join(dir, 'queue-auth.sqlite'),
      hooks: hooksWith(marker),
      retryBaseDelayMs: 1,
      maxAttempts: 1,
    });
    await queue.enqueue(photoId, localPath, [
      sftpDestination(server.port, { hostKeyFingerprint: server.fingerprint }),
    ]);
    queue.start();
    await queue.waitForIdle();

    const [item] = queue.list();
    expect(item?.state).toBe('failed');
    expect(item?.error ?? '').not.toContain(marker);
  });
});
