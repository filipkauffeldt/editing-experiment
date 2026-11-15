import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  asDestinationId,
  asPhotoId,
  type FtpDestination,
  type SftpDestination,
  type UploadItem,
  type UploadItemState,
} from '@ee/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadQueue, type ExportHooks } from '../src';
import { startFtpServer, type FtpTestServer } from './helpers/ftp-server';
import { startSftpServer, type SftpTestServer } from './helpers/sftp-server';

const photoId = asPhotoId('photo-outage');

function ftpDestination(id: string, port: number): FtpDestination {
  return {
    id: asDestinationId(id),
    name: id,
    kind: 'ftp',
    host: '127.0.0.1',
    port,
    username: 'photo',
    credentialRef: `cred-${id}`,
    security: 'none',
    remotePathTemplate: 'photos/{fileName}',
  };
}

function sftpDestination(id: string, port: number, fingerprint: string): SftpDestination {
  return {
    id: asDestinationId(id),
    name: id,
    kind: 'sftp',
    host: '127.0.0.1',
    port,
    username: 'photo',
    credentialRef: `cred-${id}`,
    hostKeyFingerprint: fingerprint,
    remotePathTemplate: 'photos/{fileName}',
  };
}

function hooksWith(password: string): ExportHooks {
  return { getSecret: async () => ({ password }) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the upload queue');
    await sleep(5);
  }
}

const states = (items: UploadItem[]): UploadItemState[] => items.map((item) => item.state);

/** Files below a root, without the `.part` names a transfer uses on the way. */
async function finalFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.part'))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe('uploads through a connection outage', () => {
  let dir: string;
  let dbPath: string;
  let ftp: FtpTestServer | undefined;
  let sftp: SftpTestServer | undefined;
  let queue: UploadQueue | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-outage-queue-'));
    dbPath = path.join(dir, 'queue.sqlite');
  });

  afterEach(async () => {
    await queue?.close();
    queue = undefined;
    await sftp?.close();
    sftp = undefined;
    await ftp?.close();
    ftp = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const localFile = async (name: string, contents: Buffer): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, contents);
    return file;
  };

  /** A small retry budget: five attempts in about 300 ms, like the old rule. */
  const OLD_RETRY_BASE_MS = 20;
  const OLD_ATTEMPT_BUDGET_MS = OLD_RETRY_BASE_MS * (1 + 2 + 4 + 8);

  async function enqueueFiles(
    destination: FtpDestination | SftpDestination,
    files: { localPath: string }[],
  ): Promise<UploadItem[]> {
    const items: UploadItem[] = [];
    for (const file of files) {
      // created_at has millisecond resolution; keep the queue order well defined.
      await sleep(2);
      items.push(...(await queue!.enqueue(photoId, file.localPath, [destination])));
    }
    return items;
  }

  function doneOrder(queueInstance: UploadQueue): string[] {
    const order: string[] = [];
    queueInstance.events.on((event) => {
      if (event.type === 'upload.state' && event.state === 'done') {
        const item = queueInstance.list().find((candidate) => candidate.id === event.uploadId);
        if (item !== undefined) order.push(path.basename(item.localPath));
      }
    });
    return order;
  }

  /** True while the queue has at least one waiting row and no probe in flight. */
  const settledWaiting = (): boolean => {
    const items = queue?.list() ?? [];
    return (
      items.some((item) => item.state === 'waiting') &&
      !items.some((item) => item.state === 'uploading')
    );
  };

  it('sends every FTP file after an outage longer than the old attempt budget', async () => {
    const root = path.join(dir, 'ftp-server');
    ftp = await startFtpServer({ root });
    const port = ftp.port;

    const contents = [Buffer.alloc(4096, 1), Buffer.alloc(32 * 1024, 2), Buffer.alloc(8 * 1024, 3)];
    const names = ['first.jpg', 'second.jpg', 'third.jpg'];
    const files = [];
    for (const [index, name] of names.entries()) {
      files.push({ localPath: await localFile(name, contents[index]!) });
    }

    queue = new UploadQueue({
      dbPath,
      hooks: hooksWith(ftp.password),
      retryBaseDelayMs: OLD_RETRY_BASE_MS,
      maxAttempts: 5,
      concurrencyPerDestination: 1,
    });
    const order = doneOrder(queue);
    await enqueueFiles(ftpDestination('outage-ftp', port), files);
    queue.start();

    await waitFor(() => queue!.list().filter((item) => item.state === 'done').length === 1);
    await ftp.close();
    ftp = undefined;

    await waitFor(() => queue!.list().some((item) => item.state === 'waiting'));
    // Longer than the four waits the old rule allowed between its five attempts.
    await sleep(OLD_ATTEMPT_BUDGET_MS + 200);
    await waitFor(settledWaiting);
    const waiting = queue.list();
    expect(states(waiting)).toEqual(['done', 'waiting', 'waiting']);
    expect(waiting[1]?.error).toBeTruthy();
    // The outage did not use up an attempt: the retry budget is untouched.
    expect(waiting[1]?.attempts).toBe(0);

    ftp = await startFtpServer({ root, port });
    await queue.waitForIdle(10_000);

    expect(states(queue.list())).toEqual(['done', 'done', 'done']);
    expect(order).toEqual(names);
    for (const [index, name] of names.entries()) {
      const finalPath = path.join(root, 'photos', name);
      expect(await readFile(finalPath)).toEqual(contents[index]);
      await expect(access(`${finalPath}.part`)).rejects.toThrow();
    }
    expect(await finalFiles(root)).toEqual([
      path.join('photos', names[0]!),
      path.join('photos', names[1]!),
      path.join('photos', names[2]!),
    ]);
  }, 20_000);

  it('sends every SFTP file after an outage longer than the old attempt budget', async () => {
    const root = path.join(dir, 'sftp-server');
    sftp = await startSftpServer({ root, dropAfterBytes: 48 * 1024 });
    const port = sftp.port;
    const fingerprint = sftp.fingerprint;
    const password = sftp.password;

    const contents = [Buffer.alloc(4096, 5), Buffer.alloc(512 * 1024, 6)];
    const names = ['first.jpg', 'second.jpg'];
    const files = [];
    for (const [index, name] of names.entries()) {
      files.push({ localPath: await localFile(name, contents[index]!) });
    }

    const retryBaseDelayMs = 100;
    queue = new UploadQueue({
      dbPath,
      hooks: hooksWith(password),
      retryBaseDelayMs,
      maxAttempts: 5,
      concurrencyPerDestination: 1,
    });
    const order = doneOrder(queue);
    await enqueueFiles(sftpDestination('outage-sftp', port, fingerprint), files);
    queue.start();

    // The second file is cut off in the middle of its data connection, then the
    // server goes away completely for longer than the old retry budget.
    await waitFor(() => sftp!.dropCount() === 1);
    await sftp.close();
    sftp = undefined;

    await waitFor(() => queue!.list().some((item) => item.state === 'waiting'));
    await sleep(retryBaseDelayMs * (1 + 2 + 4 + 8) + 200);
    await waitFor(settledWaiting);
    expect(states(queue.list())).toEqual(['done', 'waiting']);
    expect(queue.list()[1]?.attempts).toBe(0);

    sftp = await startSftpServer({ root, port });
    await queue.waitForIdle(10_000);

    expect(states(queue.list())).toEqual(['done', 'done']);
    expect(order).toEqual(names);
    for (const [index, name] of names.entries()) {
      expect(await readFile(path.join(root, 'photos', name))).toEqual(contents[index]);
    }
    expect(await finalFiles(root)).toEqual([
      path.join('photos', names[0]!),
      path.join('photos', names[1]!),
    ]);
  }, 20_000);

  it('still fails a wrong FTP and SFTP password after the limited attempts', async () => {
    ftp = await startFtpServer({ root: path.join(dir, 'ftp-auth') });
    const ftpFiles = [{ localPath: await localFile('ftp-denied.jpg', Buffer.from('x')) }];
    queue = new UploadQueue({
      dbPath: path.join(dir, 'ftp-auth.sqlite'),
      hooks: hooksWith('wrong-password'),
      retryBaseDelayMs: 5,
      maxAttempts: 2,
    });
    await enqueueFiles(ftpDestination('auth-ftp', ftp.port), ftpFiles);
    queue.start();
    await queue.waitForIdle(10_000);
    expect(queue.list()[0]).toMatchObject({ state: 'failed', attempts: 2 });
    await queue.close();
    queue = undefined;

    sftp = await startSftpServer({ root: path.join(dir, 'sftp-auth') });
    const sftpFiles = [{ localPath: await localFile('sftp-denied.jpg', Buffer.from('x')) }];
    queue = new UploadQueue({
      dbPath: path.join(dir, 'sftp-auth.sqlite'),
      hooks: hooksWith('wrong-password'),
      retryBaseDelayMs: 5,
      maxAttempts: 2,
    });
    await enqueueFiles(sftpDestination('auth-sftp', sftp.port, sftp.fingerprint), sftpFiles);
    queue.start();
    await queue.waitForIdle(10_000);
    expect(queue.list()[0]).toMatchObject({ state: 'failed', attempts: 2 });
  }, 20_000);

  it('cancels a waiting item and keeps it cancelled when the server comes back', async () => {
    const root = path.join(dir, 'cancel-server');
    ftp = await startFtpServer({ root });
    const port = ftp.port;
    const password = ftp.password;
    await ftp.close();
    ftp = undefined;

    const localPath = await localFile('cancelled.jpg', Buffer.alloc(2048, 9));
    queue = new UploadQueue({
      dbPath,
      hooks: hooksWith(password),
      retryBaseDelayMs: 20,
      maxAttempts: 5,
    });
    const [item] = await queue.enqueue(photoId, localPath, [ftpDestination('cancel-ftp', port)]);
    queue.start();
    await waitFor(() => queue!.list()[0]?.state === 'waiting');

    queue.cancel(item!.id);
    await queue.waitForIdle(5_000);
    expect(queue.list()[0]?.state).toBe('cancelled');

    ftp = await startFtpServer({ root, port });
    await sleep(OLD_ATTEMPT_BUDGET_MS + 100);
    expect(queue.list()[0]?.state).toBe('cancelled');
    await expect(access(path.join(root, 'photos', 'cancelled.jpg'))).rejects.toThrow();
  }, 20_000);

  it('keeps a waiting item waiting across a restart and sends it afterwards', async () => {
    const root = path.join(dir, 'restart-server');
    ftp = await startFtpServer({ root });
    const port = ftp.port;
    const password = ftp.password;
    await ftp.close();
    ftp = undefined;

    const contents = Buffer.alloc(16 * 1024, 4);
    const localPath = await localFile('restart.jpg', contents);
    queue = new UploadQueue({
      dbPath,
      hooks: hooksWith(password),
      retryBaseDelayMs: 20,
      maxAttempts: 5,
    });
    const [item] = await queue.enqueue(photoId, localPath, [ftpDestination('restart-ftp', port)]);
    queue.start();
    await waitFor(() => queue!.list()[0]?.state === 'waiting');
    const reason = queue.list()[0]?.error;
    await queue.close();
    queue = undefined;

    queue = new UploadQueue({
      dbPath,
      hooks: hooksWith(password),
      retryBaseDelayMs: 20,
      maxAttempts: 5,
    });
    const restored = queue.list().find((candidate) => candidate.id === item!.id);
    expect(restored).toMatchObject({ state: 'waiting', error: reason, attempts: 0 });

    ftp = await startFtpServer({ root, port });
    queue.start();
    await queue.waitForIdle(10_000);
    expect(queue.list()[0]?.state).toBe('done');
    expect(await readFile(path.join(root, 'photos', 'restart.jpg'))).toEqual(contents);
  }, 20_000);

  it('keeps sending to a reachable destination while another one is down', async () => {
    const downRoot = path.join(dir, 'down-server');
    const upRoot = path.join(dir, 'up-server');
    ftp = await startFtpServer({ root: downRoot });
    const downPort = ftp.port;
    const downPassword = ftp.password;
    await ftp.close();
    ftp = undefined;
    const up = await startFtpServer({ root: upRoot });
    try {
      const downFile = await localFile('down.jpg', Buffer.alloc(8 * 1024, 7));
      const upContents = Buffer.alloc(12 * 1024, 8);
      const upFile = await localFile('up.jpg', upContents);

      queue = new UploadQueue({
        dbPath,
        hooks: {
          getSecret: async (ref) => ({
            password: ref === 'cred-down' ? downPassword : up.password,
          }),
        },
        retryBaseDelayMs: 20,
        maxAttempts: 5,
      });
      await queue.enqueue(photoId, downFile, [ftpDestination('down', downPort)]);
      await queue.enqueue(photoId, upFile, [ftpDestination('up', up.port)]);
      queue.start();

      await waitFor(() =>
        queue!
          .list()
          .some((item) => item.destinationId === asDestinationId('up') && item.state === 'done'),
      );
      expect(
        queue.list().find((item) => item.destinationId === asDestinationId('down'))?.state,
      ).toBe('waiting');
      expect(await readFile(path.join(upRoot, 'photos', 'up.jpg'))).toEqual(upContents);
      await expect(access(path.join(downRoot, 'photos', 'down.jpg'))).rejects.toThrow();

      ftp = await startFtpServer({ root: downRoot, port: downPort });
      await queue.waitForIdle(10_000);
      await expect(access(path.join(downRoot, 'photos', 'down.jpg'))).resolves.toBeUndefined();
    } finally {
      await up.close();
    }
  }, 20_000);

  it('probes a down destination with one item, not the whole queue', async () => {
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // Hang up before the greeting: every transfer fails like a network outage.
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      const files = [];
      for (let index = 0; index < 4; index++) {
        files.push({ localPath: await localFile(`probe-${index}.jpg`, Buffer.alloc(1024, index)) });
      }
      queue = new UploadQueue({
        dbPath,
        hooks: hooksWith('whatever'),
        retryBaseDelayMs: 1_000,
        retryMaxDelayMs: 1_000,
        maxAttempts: 5,
      });
      await enqueueFiles(ftpDestination('probe', port), files);
      queue.start();

      await waitFor(() => queue!.list().filter((item) => item.state === 'waiting').length >= 2);
      await sleep(200);
      // Two concurrent slots may probe first; the other rows must not follow them.
      expect(connections).toBe(2);
      expect(states(queue.list())).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
      expect(queue.list().some((item) => item.state === 'failed')).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
