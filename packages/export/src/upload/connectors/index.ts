import type { CredentialSecret, Destination, FolderDestination } from '@ee/contracts';
import { ExportError } from '../../errors';
import type { ExportHooks } from '../../hooks';
import { safeErrorMessage } from '../redact';
import { createFolderConnector } from './folder';
import { createFtpConnector } from './ftp';
import { createSftpConnector } from './sftp';
import type { ConnectorFactory, DestinationConnector, DestinationTestResult } from '../types';

export { createFolderConnector, createFtpConnector, createSftpConnector };

/** Default connector registry. */
export const createConnector: ConnectorFactory = (
  destination: Destination,
): DestinationConnector => {
  switch (destination.kind) {
    case 'folder':
      return createFolderConnector(destination as FolderDestination);
    case 'ftp':
      return createFtpConnector(destination);
    case 'sftp':
      return createSftpConnector(destination);
  }
};

/** Resolves the secret for a destination; folder destinations need none. */
export async function getDestinationSecret(
  destination: Destination,
  hooks: ExportHooks | undefined,
): Promise<CredentialSecret> {
  if (destination.kind === 'folder') return {};
  if (hooks?.getSecret === undefined) {
    throw new ExportError(
      'missing_credentials',
      'No credential provider is configured for remote destinations',
    );
  }
  return hooks.getSecret(destination.credentialRef);
}

/** Probes a destination without throwing; credentials are scrubbed from failures. */
export async function testDestination(
  destination: Destination,
  hooks?: ExportHooks,
): Promise<DestinationTestResult> {
  let secret: CredentialSecret = {};
  try {
    secret = await getDestinationSecret(destination, hooks);
    return await createConnector(destination).test(secret);
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, secret, [
        destination.kind === 'folder' ? undefined : destination.username,
      ]),
    };
  }
}

export type { DestinationTestResult };
