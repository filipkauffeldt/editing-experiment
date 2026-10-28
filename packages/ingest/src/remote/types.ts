import type { CredentialSecret, FtpSource, SftpSource } from '@ee/contracts';

/** One entry from an FTP or SFTP directory listing. */
export interface RemoteEntry {
  name: string;
  /** Path on the server, using `/` separators. */
  path: string;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

/** Fresh metadata for a remote file, used before destructive operations. */
export interface RemoteFileStat {
  size: number;
  /** Undefined when the server cannot report a reliable modification time. */
  mtimeMs?: number;
}

export interface RemoteConnection {
  list(remotePath: string): Promise<RemoteEntry[]>;
  stat(remotePath: string): Promise<RemoteFileStat>;
  download(remotePath: string, localPath: string, signal: AbortSignal): Promise<void>;
  delete(remotePath: string): Promise<void>;
  close(): Promise<void>;
}

export type RemoteSource = FtpSource | SftpSource;

export type RemoteConnectionFactory = (
  source: RemoteSource,
  credentials: CredentialSecret,
  signal: AbortSignal,
) => Promise<RemoteConnection>;
