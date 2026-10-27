import { createHash } from 'node:crypto';
import path from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import type { CredentialSecret, SftpDestination } from '@ee/contracts';
import { NonRetryableUploadError, UploadCancelledError } from '../../errors';
import { normalizeRemotePath, tempRemotePath } from '../paths';
import type { DestinationConnector, DestinationTestResult, UploadRequest } from '../types';

/** Normalizes `SHA256:...` fingerprints for comparison (padding removed). */
export function normalizeHostKeyFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim();
  if (!trimmed.startsWith('SHA256:')) return trimmed;
  return `SHA256:${trimmed.slice('SHA256:'.length).replace(/=+$/, '')}`;
}

export function fingerprintFromSha256Hex(hex: string): string {
  const base64 = Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
  return `SHA256:${base64}`;
}

export function createSftpConnector(destination: SftpDestination): DestinationConnector {
  return {
    async upload(request: UploadRequest): Promise<void> {
      const client = createClient();
      const abort = (): void => {
        void client.end().catch(() => undefined);
      };
      request.signal.addEventListener('abort', abort, { once: true });

      try {
        await connect(client, destination, request.secret, () => undefined, false);
        if (request.signal.aborted) throw new UploadCancelledError();

        const cwd = await client.cwd();
        const finalPath = normalizeRemotePath(
          path.posix.isAbsolute(request.remotePath)
            ? request.remotePath
            : path.posix.join(cwd, request.remotePath),
        );
        const directory = path.posix.dirname(finalPath);
        if (directory !== '.' && directory !== '/') await client.mkdir(directory, true);

        const tempPath = tempRemotePath(finalPath);
        await client.fastPut(request.localPath, tempPath, {
          step: (transferred) => request.report(Math.min(transferred, request.bytesTotal)),
        });
        if (request.signal.aborted) throw new UploadCancelledError();

        try {
          await client.rename(tempPath, finalPath);
        } catch (error) {
          // Plain SFTP rename may refuse to overwrite; OpenSSH's posix-rename
          // replaces atomically. Never delete the existing remote file.
          if (request.signal.aborted) throw new UploadCancelledError();
          await client.posixRename(tempPath, finalPath).catch(() => {
            throw error;
          });
        }
        request.report(request.bytesTotal);
      } finally {
        request.signal.removeEventListener('abort', abort);
        await client.end().catch(() => undefined);
      }
    },

    async test(secret: CredentialSecret): Promise<DestinationTestResult> {
      const client = createClient();
      let fingerprint: string | undefined;
      try {
        await connect(
          client,
          destination,
          secret,
          (value) => {
            fingerprint = value;
          },
          true,
        );
        const cwd = await client.cwd();
        return {
          ok: true,
          message: `Connected to ${destination.host}:${destination.port} (${cwd})`,
          ...(fingerprint === undefined ? {} : { hostKeyFingerprint: fingerprint }),
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

function createClient(): SftpClient {
  // Do not use the defaults: they print lifecycle events to the console.
  return new SftpClient('ee-upload', {
    error: () => undefined,
    end: () => undefined,
    close: () => undefined,
  });
}

async function connect(
  client: SftpClient,
  destination: SftpDestination,
  secret: CredentialSecret,
  onFingerprint: (fingerprint: string) => void,
  allowUnpinned: boolean,
): Promise<void> {
  if (typeof secret.password !== 'string' && typeof secret.privateKey !== 'string') {
    throw new NonRetryableUploadError(
      'missing_credentials',
      'SFTP destination has neither a password nor a private key',
    );
  }
  if (!allowUnpinned && destination.hostKeyFingerprint === undefined) {
    throw new NonRetryableUploadError(
      'host_key_unpinned',
      'SFTP upload requires a pinned host key fingerprint',
    );
  }

  const pinned =
    destination.hostKeyFingerprint === undefined
      ? undefined
      : normalizeHostKeyFingerprint(destination.hostKeyFingerprint);
  let rejectedHostKey = false;

  const hostVerifier = (hashedKey: string | Buffer): boolean => {
    const hex = typeof hashedKey === 'string' ? hashedKey : hashedKey.toString('hex');
    const fingerprint = fingerprintFromSha256Hex(hex);
    onFingerprint(fingerprint);
    const matches = pinned === undefined || normalizeHostKeyFingerprint(fingerprint) === pinned;
    if (!matches) rejectedHostKey = true;
    return matches;
  };

  try {
    await client.connect({
      host: destination.host,
      port: destination.port,
      username: destination.username,
      ...(secret.password === undefined ? {} : { password: secret.password }),
      ...(secret.privateKey === undefined ? {} : { privateKey: secret.privateKey }),
      ...(secret.passphrase === undefined ? {} : { passphrase: secret.passphrase }),
      hostHash: 'sha256',
      hostVerifier,
    });
  } catch (error) {
    if (rejectedHostKey) {
      throw new NonRetryableUploadError(
        'host_key_mismatch',
        'SFTP host key does not match the pinned fingerprint',
        { cause: error },
      );
    }
    throw error;
  }
}

/** Exposed for tests: the SHA256 fingerprint of a public key blob. */
export function sha256Fingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}
