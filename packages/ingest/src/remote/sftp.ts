import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import type { CredentialSecret, SftpSource } from '@ee/contracts';
import { IngestAbortError, throwIfAborted } from '../errors';
import type { RemoteConnection, RemoteEntry, RemoteFileStat } from './types';

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new IngestAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new IngestAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

class SftpRemoteConnection implements RemoteConnection {
  constructor(
    private readonly client: SftpClient,
    private readonly signal: AbortSignal,
    private readonly onAbort: () => void,
  ) {}

  async list(remotePath: string): Promise<RemoteEntry[]> {
    const entries = await abortable(this.client.list(remotePath), this.signal);
    return entries.map((entry) => ({
      name: entry.name,
      path: posix.join(remotePath || '/', entry.name),
      size: entry.size,
      mtimeMs: entry.modifyTime || 0,
      isDirectory: entry.type === 'd',
    }));
  }

  async stat(remotePath: string): Promise<RemoteFileStat> {
    const info = await abortable(this.client.stat(remotePath), this.signal);
    return { size: info.size, mtimeMs: info.modifyTime };
  }

  async download(remotePath: string, localPath: string, signal: AbortSignal): Promise<void> {
    await abortable(this.client.get(remotePath, localPath), signal);
    throwIfAborted(signal);
  }

  async delete(remotePath: string): Promise<void> {
    await abortable(this.client.delete(remotePath), this.signal);
  }

  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.onAbort);
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
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      ...(source.hostKeyFingerprint
        ? { hostVerifier: (key: Buffer) => fingerprint(key) === source.hostKeyFingerprint }
        : {}),
    });
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    throwIfAborted(signal);
    throw error;
  }
  if (signal.aborted) {
    signal.removeEventListener('abort', onAbort);
    await client.end().catch(() => undefined);
    throw new IngestAbortError();
  }
  return new SftpRemoteConnection(client, signal, onAbort);
}
