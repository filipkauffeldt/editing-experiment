import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import type { CredentialSecret, SftpSource } from '@ee/contracts';
import { IngestAbortError, throwIfAborted } from '../errors';
import type { RemoteConnection, RemoteEntry } from './types';

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

class SftpRemoteConnection implements RemoteConnection {
  constructor(private readonly client: SftpClient) {}

  async list(remotePath: string): Promise<RemoteEntry[]> {
    const entries = await this.client.list(remotePath);
    return entries.map((entry) => ({
      name: entry.name,
      path: posix.join(remotePath || '/', entry.name),
      size: entry.size,
      mtimeMs: entry.modifyTime || 0,
      isDirectory: entry.type === 'd',
    }));
  }

  async download(remotePath: string, localPath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const onAbort = (): void => {
      void this.client.end().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.client.get(remotePath, localPath);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    throwIfAborted(signal);
  }

  async delete(remotePath: string): Promise<void> {
    await this.client.delete(remotePath);
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }
}

export async function openSftpConnection(
  source: SftpSource,
  credentials: CredentialSecret,
  signal: AbortSignal,
): Promise<RemoteConnection> {
  throwIfAborted(signal);
  const client = new SftpClient('ee-ingest');
  const onAbort = (): void => {
    void client.end().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect({
      host: source.host,
      port: source.port,
      username: source.username,
      ...(credentials.password ? { password: credentials.password } : {}),
      ...(credentials.privateKey ? { privateKey: credentials.privateKey } : {}),
      ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
      readyTimeout: 20_000,
      ...(source.hostKeyFingerprint
        ? { hostVerifier: (key: Buffer) => fingerprint(key) === source.hostKeyFingerprint }
        : {}),
    });
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) {
    await client.end().catch(() => undefined);
    throw new IngestAbortError();
  }
  return new SftpRemoteConnection(client);
}
