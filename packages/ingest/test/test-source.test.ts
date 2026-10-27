import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asSourceId, type FolderSource, type SftpSource } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startIngest } from '../src/engine';
import { testSource } from '../src/test-source';
import type { IngestHandle } from '../src/types';
import { ingestConfig, pathExists, waitFor } from './helpers/engine';
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

const getSecret = async (): Promise<{ password: string }> => ({ password: 'secret' });

describe('testSource', { timeout: 15_000 }, () => {
  it('tests a folder source', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, 'a.NEF'), 'raw');
    const source: FolderSource = {
      kind: 'folder',
      id: asSourceId('folder'),
      name: 'Folder',
      path: root,
    };

    const result = await testSource(source);

    expect(result).toEqual({ ok: true, message: '1 image found' });
  });

  it('reports an SFTP fingerprint and ingest refuses an unpinned server', async () => {
    const root = await makeTempDir();
    const destination = await makeTempDir();
    const server = await startSftpServer({ root });
    servers.push(server);
    const source: SftpSource = {
      kind: 'sftp',
      id: asSourceId('sftp'),
      name: 'SFTP',
      host: '127.0.0.1',
      port: server.port,
      username: 'user',
      credentialRef: 'sftp-cred',
      remotePath: '/',
      pollIntervalMs: 60,
      deleteAfterDownload: false,
    };

    const result = await testSource(source, { getSecret });
    expect(result.ok).toBe(true);
    expect(result.hostKeyFingerprint).toBe(server.hostKeyFingerprint);

    const unpinned = startIngest(ingestConfig(source, destination), { getSecret });
    handles.push(unpinned);
    await unpinned.done;
    expect(unpinned.status()[0]?.state).toBe('failed');
    expect(unpinned.status()[0]?.error).toContain('host key fingerprint');

    await writeFile(join(root, '_DSC1.NEF'), 'pinned-raw');
    const pinned = startIngest(
      ingestConfig({ ...source, hostKeyFingerprint: result.hostKeyFingerprint }, destination),
      { getSecret },
    );
    handles.push(pinned);
    await waitFor(
      () => pathExists(join(destination, '_DSC1_01.NEF')),
      'download with pinned host key',
    );
  });

  it('reports an SSH host key mismatch as a failed test', async () => {
    const root = await makeTempDir();
    await mkdir(root, { recursive: true });
    const server = await startSftpServer({ root });
    servers.push(server);
    const source: SftpSource = {
      kind: 'sftp',
      id: asSourceId('sftp'),
      name: 'SFTP',
      host: '127.0.0.1',
      port: server.port,
      username: 'user',
      credentialRef: 'sftp-cred',
      remotePath: '/',
      pollIntervalMs: 60,
      deleteAfterDownload: false,
      hostKeyFingerprint: 'SHA256:not-the-server-key',
    };

    const result = await testSource(source, { getSecret, timeoutMs: 5_000 });

    expect(result.ok).toBe(false);
  });
});
