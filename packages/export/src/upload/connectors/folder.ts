import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { atomicReplace } from '../../atomic';
import type { CredentialSecret, FolderDestination } from '@ee/contracts';
import { UploadCancelledError } from '../../errors';
import { resolveFolderDestinationPath, tempRemotePath } from '../paths';
import type { DestinationConnector, DestinationTestResult, UploadRequest } from '../types';

export function createFolderConnector(destination: FolderDestination): DestinationConnector {
  return {
    async upload(request: UploadRequest): Promise<void> {
      const finalPath = resolveFolderDestinationPath(destination.path, request.remotePath);
      const tempPath = tempRemotePath(finalPath, request.uploadId, request.claimToken);
      await mkdir(path.dirname(finalPath), { recursive: true });

      const source = createReadStream(request.localPath);
      const target = createWriteStream(tempPath, { flags: 'w' });
      let sent = 0;
      source.on('data', (chunk: string | Buffer) => {
        sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        request.report(sent);
      });

      try {
        await pipeline(source, target, { signal: request.signal });
        if (request.signal.aborted) throw new UploadCancelledError();
        await atomicReplace(tempPath, finalPath);
        request.report(request.bytesTotal);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        if (request.signal.aborted) throw new UploadCancelledError();
        throw error;
      }
    },

    async test(_secret: CredentialSecret): Promise<DestinationTestResult> {
      const probe = path.join(destination.path, `.ee-write-test-${randomUUID()}`);
      try {
        await mkdir(destination.path, { recursive: true });
        await writeFile(probe, 'ok', { flag: 'wx' });
        await rm(probe, { force: true });
        return { ok: true, message: `Writable folder: ${destination.path}` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
