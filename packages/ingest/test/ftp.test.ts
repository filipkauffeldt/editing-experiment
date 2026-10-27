import { appendFile, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asSourceId, type FtpSource, type JobEvent } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startIngest } from '../src/engine';
import type { IngestHandle } from '../src/types';
import { delay, ingestConfig, pathExists, waitFor } from './helpers/engine';
import { startFtpServer, type TestFtpServer } from './helpers/ftp-server';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

const servers: TestFtpServer[] = [];
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
  password?: string;
  echoPasswordOnFailure?: boolean;
  pollIntervalMs?: number;
  deleteAfterDownload?: boolean;
}

interface Setup {
  root: string;
  destination: string;
  server: TestFtpServer;
  source: FtpSource;
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const root = await makeTempDir();
  const destination = await makeTempDir();
  const server = await startFtpServer({
    root,
    password: options.password,
    echoPasswordOnFailure: options.echoPasswordOnFailure,
  });
  servers.push(server);
  return {
    root,
    destination,
    server,
    source: {
      kind: 'ftp',
      id: asSourceId('ftp'),
      name: 'FTP',
      host: '127.0.0.1',
      port: server.port,
      username: 'user',
      credentialRef: 'ftp-cred',
      remotePath: '/',
      pollIntervalMs: options.pollIntervalMs ?? 60,
      deleteAfterDownload: options.deleteAfterDownload ?? false,
      security: 'none',
    },
  };
}

function start(setupResult: Setup, hooks: Parameters<typeof startIngest>[1] = {}): IngestHandle {
  const handle = startIngest(ingestConfig(setupResult.source, setupResult.destination), {
    getSecret: async () => ({ password: 'secret' }),
    retryBaseDelayMs: 20,
    ...hooks,
  });
  handles.push(handle);
  return handle;
}

async function waitForWatching(handle: IngestHandle): Promise<void> {
  await waitFor(() => handle.status()[0]?.state === 'watching', 'remote source to watch');
}

describe('FTP source', { timeout: 15_000 }, () => {
  it('downloads a new file and its sidecar once it is stable', async () => {
    const setupResult = await setup();
    const { root, destination } = setupResult;
    const handle = start(setupResult);
    await waitForWatching(handle);

    await writeFile(join(root, '_DSC1.NEF'), 'raw-one');
    await writeFile(join(root, '_DSC1.xmp'), '<xmp/>');

    await waitFor(() => pathExists(join(destination, '_DSC1_01.NEF')), 'raw download');
    await waitFor(() => pathExists(join(destination, '_DSC1_01.xmp')), 'sidecar download');
    expect(await readFile(join(destination, '_DSC1_01.NEF'), 'utf8')).toBe('raw-one');
    expect(await readFile(join(destination, '_DSC1_01.xmp'), 'utf8')).toBe('<xmp/>');
    await waitForWatching(handle);
    expect(handle.status()[0]?.state).toBe('watching');
  });

  it('does not download a file that is still growing', async () => {
    const setupResult = await setup({ pollIntervalMs: 100 });
    const { root, destination } = setupResult;
    const remote = join(root, '_DSC2.NEF');
    await writeFile(remote, '0123456789');
    const handle = start(setupResult);
    await waitForWatching(handle);

    await appendFile(remote, 'abcdefghij');
    await delay(130);
    expect(await readdir(destination)).toEqual([]);

    await waitFor(() => pathExists(join(destination, '_DSC2_01.NEF')), 'stable file download');
    expect(await readFile(join(destination, '_DSC2_01.NEF'), 'utf8')).toBe('0123456789abcdefghij');
  });

  it('ignores temp names and picks up the file after it is renamed', async () => {
    const setupResult = await setup();
    const { root, destination } = setupResult;
    const temp = join(root, 'upload.tmp');
    await writeFile(temp, 'complete-photo');
    start(setupResult);

    await delay(250);
    expect(await readdir(destination)).toEqual([]);

    await rename(temp, join(root, '_DSC5.NEF'));
    await waitFor(() => pathExists(join(destination, '_DSC5_01.NEF')), 'renamed file download');
    expect(await readFile(join(destination, '_DSC5_01.NEF'), 'utf8')).toBe('complete-photo');
  });

  it('reconnects and keeps watching after the connection drops', async () => {
    const setupResult = await setup();
    const { root, destination, server } = setupResult;
    const events: JobEvent[] = [];
    const handle = start(setupResult);
    handle.on((event) => events.push(event));
    await waitForWatching(handle);

    await server.disconnectAll();
    await waitFor(
      () => events.some((event) => event.type === 'job.error'),
      'connection error event',
    );

    await writeFile(join(root, '_DSC7.NEF'), 'after-reconnect');
    await waitFor(() => pathExists(join(destination, '_DSC7_01.NEF')), 'file after reconnect');
    expect(handle.status()[0]?.state).toMatch(/watching|running/);
  });

  it.each([false, true])('handles deleteAfterDownload=%s', async (deleteAfterDownload) => {
    const setupResult = await setup({ deleteAfterDownload });
    const { root, destination } = setupResult;
    const handle = start(setupResult);
    await waitForWatching(handle);
    await writeFile(join(root, '_DSC9.NEF'), 'raw-nine');

    await waitFor(() => pathExists(join(destination, '_DSC9_01.NEF')), 'download');
    if (deleteAfterDownload) {
      await waitFor(async () => !(await pathExists(join(root, '_DSC9.NEF'))), 'remote delete');
    } else {
      expect(await pathExists(join(root, '_DSC9.NEF'))).toBe(true);
    }
  });

  it('refuses to delete a remote file that changed after download', async () => {
    const setupResult = await setup({ deleteAfterDownload: true });
    const { root, destination } = setupResult;
    const remote = join(root, '_DSC9.NEF');
    const events: JobEvent[] = [];
    const handle = start(setupResult, {
      onFileIngested: async () => {
        await appendFile(remote, ' changed');
      },
    });
    handle.on((event) => events.push(event));
    await waitForWatching(handle);
    await writeFile(remote, 'original');

    await waitFor(() => pathExists(join(destination, '_DSC9_01.NEF')), 'download');
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'job.error' && event.message.includes('changed before deletion'),
        ),
      'changed-file error',
    );

    expect(await readFile(join(destination, '_DSC9_01.NEF'), 'utf8')).toBe('original');
    expect(await readFile(remote, 'utf8')).toBe('original changed');
  });

  it('never puts credentials in events or status errors', async () => {
    const secret = 'super-secret-123';
    const setupResult = await setup({ echoPasswordOnFailure: true });
    const events: JobEvent[] = [];
    const handle = start(setupResult, {
      getSecret: async () => ({ password: secret }),
    });
    handle.on((event) => events.push(event));

    await waitFor(() => events.some((event) => event.type === 'job.error'), 'login failure');
    const output = `${JSON.stringify(events)}\n${JSON.stringify(handle.status())}`;
    expect(output).not.toContain(secret);
    expect(output).toContain('[redacted]');
  });
});
