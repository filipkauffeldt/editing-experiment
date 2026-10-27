import path from 'node:path';
import { Client } from 'basic-ftp';
import type { CredentialSecret, FtpDestination } from '@ee/contracts';
import { ExportError, NonRetryableUploadError, UploadCancelledError } from '../../errors';
import { normalizeRemotePath, tempRemotePath } from '../paths';
import type { DestinationConnector, DestinationTestResult, UploadRequest } from '../types';

export function createFtpConnector(destination: FtpDestination): DestinationConnector {
  return {
    async upload(request: UploadRequest): Promise<void> {
      const client = new Client(30_000);
      const abort = (): void => client.close();
      request.signal.addEventListener('abort', abort, { once: true });
      let tempPath: string | undefined;
      let renamed = false;
      try {
        await connect(client, destination, request.secret);
        if (request.signal.aborted) throw new UploadCancelledError();

        const cwd = await client.pwd();
        const finalPath = normalizeRemotePath(joinRemote(cwd, request.remotePath));
        const directory = path.posix.dirname(finalPath);
        if (directory !== '.' && directory !== '/') await client.ensureDir(directory);

        const alreadyExists = await client.size(finalPath).then(
          () => true,
          () => false,
        );
        if (alreadyExists) {
          throw new NonRetryableUploadError(
            'remote_exists',
            `Remote file already exists: ${finalPath}`,
          );
        }

        tempPath = tempRemotePath(finalPath, request.uploadId, request.claimToken);
        client.trackProgress((info) => {
          request.report(Math.min(info.bytesOverall, request.bytesTotal));
        });
        await client.uploadFrom(request.localPath, tempPath);
        client.trackProgress();
        if (request.signal.aborted) throw new UploadCancelledError();

        try {
          await client.rename(tempPath, finalPath);
        } catch (error) {
          if (request.signal.aborted) throw new UploadCancelledError();
          const targetExists = await client.size(finalPath).then(
            () => true,
            () => false,
          );
          if (targetExists) {
            throw new NonRetryableUploadError(
              'remote_exists',
              `Remote file already exists: ${finalPath}`,
              { cause: error },
            );
          }
          throw error;
        }
        renamed = true;
        request.report(request.bytesTotal);
      } catch (error) {
        if (!renamed && tempPath !== undefined) {
          await client.remove(tempPath).catch(() => undefined);
        }
        throw error;
      } finally {
        client.trackProgress();
        request.signal.removeEventListener('abort', abort);
        client.close();
      }
    },

    async test(secret: CredentialSecret): Promise<DestinationTestResult> {
      const client = new Client(15_000);
      try {
        await connect(client, destination, secret);
        const cwd = await client.pwd();
        return {
          ok: true,
          message: `Connected to ${destination.host}:${destination.port} (${cwd})`,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        client.close();
      }
    },
  };
}

async function connect(
  client: Client,
  destination: FtpDestination,
  secret: CredentialSecret,
): Promise<void> {
  if (typeof secret.password !== 'string') {
    throw new ExportError('missing_credentials', 'FTP destination has no password credential');
  }
  const secure: boolean | 'implicit' =
    destination.security === 'implicit-tls' ? 'implicit' : destination.security === 'explicit-tls';
  await client.access({
    host: destination.host,
    port: destination.port,
    user: destination.username,
    password: secret.password,
    secure,
  });
}

function joinRemote(cwd: string, remotePath: string): string {
  return path.posix.isAbsolute(remotePath) ? remotePath : path.posix.join(cwd, remotePath);
}
