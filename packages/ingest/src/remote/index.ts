import { IngestError } from '../errors';
import type { CredentialSecret } from '@ee/contracts';
import type { RemoteConnection, RemoteSource } from './types';

export async function connectRemote(
  _source: RemoteSource,
  _credentials: CredentialSecret,
  _signal: AbortSignal,
): Promise<RemoteConnection> {
  throw new IngestError('Remote ingest is not wired yet', 'unsupported-source');
}
