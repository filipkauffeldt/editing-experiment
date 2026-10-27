import { posix } from 'node:path';
import { Client } from 'basic-ftp';
import type { CredentialSecret, FtpSource } from '@ee/contracts';
import { IngestAbortError, throwIfAborted } from '../errors';
import type { RemoteConnection, RemoteEntry } from './types';

class FtpRemoteConnection implements RemoteConnection {
  constructor(private readonly client: Client) {}

  async list(remotePath: string): Promise<RemoteEntry[]> {
    const entries = await this.client.list(remotePath);
    return entries
      .filter((entry) => entry.name !== '.' && entry.name !== '..')
      .map((entry) => ({
        name: entry.name,
        path: posix.join(remotePath || '/', entry.name),
        size: entry.size,
        mtimeMs: entry.modifiedAt?.getTime() ?? 0,
        isDirectory: entry.isDirectory,
      }));
  }

  async download(remotePath: string, localPath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const onAbort = (): void => this.client.close();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.client.downloadTo(localPath, remotePath);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    throwIfAborted(signal);
  }

  async delete(remotePath: string): Promise<void> {
    await this.client.remove(remotePath);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

export async function openFtpConnection(
  source: FtpSource,
  credentials: CredentialSecret,
  signal: AbortSignal,
): Promise<RemoteConnection> {
  throwIfAborted(signal);
  const client = new Client(20_000);
  const onAbort = (): void => client.close();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.access({
      host: source.host,
      port: source.port,
      user: source.username,
      password: credentials.password ?? '',
      // basic-ftp prefers MLSD and falls back to LIST on servers without it.
      secure:
        source.security === 'none' ? false : source.security === 'implicit-tls' ? 'implicit' : true,
    });
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) {
    client.close();
    throw new IngestAbortError();
  }
  return new FtpRemoteConnection(client);
}
