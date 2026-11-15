import { ExportError, UploadCancelledError } from '../errors';

/** Why a transfer is waiting for the network instead of using up an attempt. */
export type ConnectionOutage = 'unreachable' | 'lost' | 'timeout';

/**
 * Node system errno codes that mean the network is not there right now. Only
 * these are outages: a local `ENOENT` or a remote `EACCES` will not fix itself.
 */
const NETWORK_CODES = new Map<string, ConnectionOutage>([
  ['ECONNREFUSED', 'unreachable'],
  ['ENOTFOUND', 'unreachable'],
  ['EAI_AGAIN', 'unreachable'],
  ['ENETUNREACH', 'unreachable'],
  ['EHOSTUNREACH', 'unreachable'],
  ['ENETDOWN', 'unreachable'],
  ['EHOSTDOWN', 'unreachable'],
  ['ECONNRESET', 'lost'],
  ['ECONNABORTED', 'lost'],
  ['EPIPE', 'lost'],
  ['ERR_NOT_CONNECTED', 'lost'],
  ['ETIMEDOUT', 'timeout'],
  ['ESOCKETTIMEDOUT', 'timeout'],
]);

/** FTP replies that ask for another try rather than refusing the file for good. */
const FTP_OUTAGE_CODES = new Map<number, ConnectionOutage>([
  [421, 'unreachable'], // Service not available, closing control connection.
  [425, 'unreachable'], // Can't open data connection.
  [426, 'lost'], // Connection closed, transfer aborted.
]);

/**
 * basic-ftp and ssh2-sftp-client turn a lost socket or a timeout into a plain
 * Error without an errno code, so their wording is the only signal.
 */
const LOST_MESSAGES = [
  'connection lost',
  'connection closed',
  'connection reset',
  'econnreset',
  'server sent fin packet',
  'server closed connection unexpectedly',
  'socket hang up',
  'socket closed',
  'client is closed because',
  'transmission error',
  'no response from server',
  'no sftp connection',
];

const UNREACHABLE_MESSAGES = ['address lookup failed', "can't open data connection"];

const TIMEOUT_MESSAGES = ['timed out', 'timeout'];

/** Causes that look like a connection problem but are a refused login. */
const NOT_OUTAGE_MESSAGES = ['all configured authentication methods failed'];

/**
 * Classifies a failed transfer. `undefined` means the failure has a cause that
 * retrying will not fix (wrong login, permission denied, a missing local file)
 * or that this package raised it itself.
 */
export function connectionOutage(error: unknown): ConnectionOutage | undefined {
  if (error instanceof ExportError || error instanceof UploadCancelledError) return undefined;

  // Connector wrappers may add a cause; the innermost network error is the one that counts.
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'number') {
        const outage = FTP_OUTAGE_CODES.get(code);
        if (outage !== undefined) return outage;
      } else if (typeof code === 'string') {
        const outage = NETWORK_CODES.get(code.toUpperCase());
        if (outage !== undefined) return outage;
      }

      const message = current.message.toLowerCase();
      if (!NOT_OUTAGE_MESSAGES.some((entry) => message.includes(entry))) {
        if (TIMEOUT_MESSAGES.some((entry) => message.includes(entry))) return 'timeout';
        if (LOST_MESSAGES.some((entry) => message.includes(entry))) return 'lost';
        if (UNREACHABLE_MESSAGES.some((entry) => message.includes(entry))) return 'unreachable';
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function isConnectionOutage(error: unknown): boolean {
  return connectionOutage(error) !== undefined;
}

const OUTAGE_REASON: Record<ConnectionOutage, string> = {
  unreachable: 'Cannot reach the server',
  lost: 'The connection was lost',
  timeout: 'The server did not answer in time',
};

/** Short plain words for the upload popover, never the connector's raw error. */
export function outageReason(outage: ConnectionOutage): string {
  return OUTAGE_REASON[outage];
}
