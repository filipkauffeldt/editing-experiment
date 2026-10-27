import { appendFile, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asSourceId, type JobEvent, type SftpSource } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startIngest } from '../src/engine';
import type { IngestHandle } from '../src/types';
import { delay, ingestConfig, pathExists, waitFor } from './helpers/engine';
import { startSftpServer, type TestSftpServer } from './helpers/sftp-server';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

const servers: TestSftpServer[] = [];
const handles: IngestHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.stop();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  await cleanupTempDirs();
});

interface SetupOptions {
  pollIntervalMs?: number;
  deleteAfterDownload?: boolean;
}

interface Setup {
  root: string;
  destination: string;
  server: TestSftpServer;
  source: SftpSource;
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const root = await makeTempDir();
  const destination = await makeTempDir();
  const server = await startSftpServer({ root });
  servers.push(server);
  return {
    root,
    destination,
    server,
    source: {
      kind: 'sftp',
      id: asSourceId('sftp'),
      name: 'SFTP',
      host: '127.0.0.1',
      port: server.port,
      username: 'user',
      credentialRef: 'sftp-cred',
      remotePath: '/',
      pollIntervalMs: options.pollIntervalMs ?? 80,
      deleteAfterDownload: options.deleteAfterDownload ?? false,
    },
  };
}

function start(setupResult: Setup, hooks: Parameters<typeof startIngest>[1] = {}): IngestHandle {
  const handle = startIngest(ingestConfig(setupResult.source, setupResult.destination), {
    getSecret: async () => ({ password: 'secret' }),
    retryBaseDelayMs: 30,
    ...hooks,
  });
  handles.push(handle);
  return handle;
}

async function waitForWatching(handle: IngestHandle): Promise<void> {
  await waitFor(() => handle.status()[0]?.state === 'watching', 'SFTP source to watch', 8_000);
}

describe('SFTP source', { timeout: 15_000 }, () => {
  it('downloads a new file and its sidecar once it is stable', async () => {
    const setupResult = await setup();
    const { root, destination } = setupResult;
    const handle = start(setupResult);
    await waitForWatching(handle);

    await writeFile(join(root, '_DSC1.NEF'), 'sftp-raw');
    await writeFile(join(root, '_DSC1.xmp'), '<xmp/>');

    await waitFor(() => pathExists(join(destination, '_DSC1_01.NEF')), 'SFTP raw download', 8_000);
    await waitFor(
      () => pathExists(join(destination, '_DSC1_01.xmp')),
      'SFTP sidecar download',
      8_000,
    );
    expect(await readFile(join(destination, '_DSC1_01.NEF'), 'utf8')).toBe('sftp-raw');
    await waitForWatching(handle);
    expect(handle.status()[0]?.state).toBe('watching');
  });

  it('does not download a file that is still growing', async () => {
    const setupResult = await setup({ pollIntervalMs: 120 });
    const { root, destination } = setupResult;
    const remote = join(root, '_DSC2.NEF');
    await writeFile(remote, '0123456789');
    const handle = start(setupResult);
    await waitForWatching(handle);

    await appendFile(remote, 'abcdefghij');
    await delay(160);
    expect(await readdir(destination)).toEqual([]);

    await waitFor(
      () => pathExists(join(destination, '_DSC2_01.NEF')),
      'stable SFTP download',
      8_000,
    );
    expect(await readFile(join(destination, '_DSC2_01.NEF'), 'utf8')).toBe('0123456789abcdefghij');
  });

  it('ignores temp names and picks up the file after it is renamed', async () => {
    const setupResult = await setup();
    const { root, destination } = setupResult;
    const temp = join(root, 'upload.part');
    await writeFile(temp, 'complete-photo');
    start(setupResult);

    await delay(350);
    expect(await readdir(destination)).toEqual([]);

    await rename(temp, join(root, '_DSC5.NEF'));
    await waitFor(() => pathExists(join(destination, '_DSC5_01.NEF')), 'renamed SFTP file', 8_000);
    expect(await readFile(join(destination, '_DSC5_01.NEF'), 'utf8')).toBe('complete-photo');
  });

  it('reconnects and keeps watching after the connection drops', async () => {
    const setupResult = await setup();
    const { root, destination, server } = setupResult;
    const events: JobEvent[] = [];
    const handle = start(setupResult);
    handle.on((event) => events.push(event));
    await waitForWatching(handle);

    server.dropConnections();
    await waitFor(
      () => events.some((event) => event.type === 'job.error'),
      'SFTP connection error',
      8_000,
    );

    await writeFile(join(root, '_DSC7.NEF'), 'after-reconnect');
    await waitFor(
      () => pathExists(join(destination, '_DSC7_01.NEF')),
      'SFTP file after reconnect',
      8_000,
    );
    expect(handle.status()[0]?.state).toMatch(/watching|running/);
  });

  it.each([false, true])('handles deleteAfterDownload=%s', async (deleteAfterDownload) => {
    const setupResult = await setup({ deleteAfterDownload });
    const { root, destination } = setupResult;
    const handle = start(setupResult);
    await waitForWatching(handle);
    await writeFile(join(root, '_DSC9.NEF'), 'sftp-nine');

    await waitFor(() => pathExists(join(destination, '_DSC9_01.NEF')), 'SFTP download', 8_000);
    if (deleteAfterDownload) {
      await waitFor(async () => !(await pathExists(join(root, '_DSC9.NEF'))), 'remote delete');
    } else {
      expect(await pathExists(join(root, '_DSC9.NEF'))).toBe(true);
    }
  });
});
