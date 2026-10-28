import type { ConnectionTestResult, SourceConfig } from '@ee/contracts';
import { IngestError, errorMessage, redactSecrets } from './errors';
import { openFtpConnection } from './remote/ftp';
import { openSftpConnection } from './remote/sftp';
import type { RemoteConnection } from './remote/types';
import { listSourceFiles } from './sources';
import type { GetSecret } from './types';

export interface TestSourceOptions {
  getSecret?: GetSecret;
  /** Defaults to 15 seconds. */
  timeoutMs?: number;
}

export interface TestSourceResult extends ConnectionTestResult {
  /** Returned for SFTP so the UI can show it for the user to confirm. */
  hostKeyFingerprint?: string;
}

function secretValues(credentials: {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}): string[] {
  return [credentials.password, credentials.privateKey, credentials.passphrase].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * Tests a configured source. Remote SFTP servers are allowed to be unpinned
 * here so the UI can show the host key fingerprint for trust-on-first-use;
 * actual ingest refuses to connect without a pin.
 */
export async function testSource(
  source: SourceConfig,
  options: TestSourceOptions = {},
): Promise<TestSourceResult> {
  if (source.kind === 'folder' || source.kind === 'card') {
    try {
      const files = await listSourceFiles(source);
      return { ok: true, message: `${files.length} image${files.length === 1 ? '' : 's'} found` };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  const anonymous = source.kind === 'ftp' && !source.credentialRef;
  if (!anonymous && !options.getSecret) {
    return { ok: false, message: 'No credential provider is configured' };
  }

  let credentials = {};
  try {
    if (!anonymous) credentials = await options.getSecret!(source.credentialRef!);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  const secrets = secretValues(credentials);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let connection: RemoteConnection | undefined;
  let hostKeyFingerprint: string | undefined;
  try {
    if (source.kind === 'ftp') {
      connection = await openFtpConnection(source, credentials, controller.signal);
    } else {
      connection = await openSftpConnection(source, credentials, controller.signal, {
        allowUnpinnedHostKey: true,
        onHostKey: (fingerprint) => {
          hostKeyFingerprint = fingerprint;
        },
      });
    }
    await connection.list(source.remotePath);
    return {
      ok: true,
      message: `Connected to ${source.host}:${source.port}`,
      ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
    };
  } catch (error) {
    const message =
      controller.signal.aborted && !(error instanceof IngestError)
        ? 'Connection timed out'
        : redactSecrets(errorMessage(error), secrets);
    return {
      ok: false,
      message,
      ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
    };
  } finally {
    clearTimeout(timer);
    await connection?.close().catch(() => undefined);
  }
}
