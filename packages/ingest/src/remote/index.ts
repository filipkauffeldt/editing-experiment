import type { CredentialSecret } from '@ee/contracts';
import { IngestError } from '../errors';
import { openFtpConnection } from './ftp';
import type { RemoteConnection, RemoteSource } from './types';

export async function connectRemote(
  source: RemoteSource,
  credentials: CredentialSecret,
  signal: AbortSignal,
): Promise<RemoteConnection> {
  if (source.kind === 'ftp') {
    return openFtpConnection(source, credentials, signal);
  }
  throw new IngestError(`Remote source kind ${source.kind} is not supported`, 'unsupported-source');
}
