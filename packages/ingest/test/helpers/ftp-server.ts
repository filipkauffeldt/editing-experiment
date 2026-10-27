import type { AddressInfo } from 'node:net';
import { FtpSrv } from 'ftp-srv';

interface SilentLog {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(): SilentLog;
}

const silentLog: SilentLog = {
  trace: (..._args: unknown[]): void => undefined,
  debug: (..._args: unknown[]): void => undefined,
  info: (..._args: unknown[]): void => undefined,
  warn: (..._args: unknown[]): void => undefined,
  error: (..._args: unknown[]): void => undefined,
  fatal: (..._args: unknown[]): void => undefined,
  child(): SilentLog {
    return silentLog;
  },
};

export interface TestFtpServerOptions {
  root: string;
  username?: string;
  password?: string;
  /** Include the attempted password in the rejection message, to prove redaction. */
  echoPasswordOnFailure?: boolean;
}

export interface TestFtpServer {
  readonly server: FtpSrv;
  readonly root: string;
  readonly port: number;
  connectionIds(): string[];
  disconnectAll(): Promise<void>;
  close(): Promise<void>;
}

function internal(server: FtpSrv): {
  server: { address(): AddressInfo | string | null };
  connections: Record<string, unknown>;
  disconnectClient(id: string): Promise<unknown>;
} {
  return server as unknown as {
    server: { address(): AddressInfo | string | null };
    connections: Record<string, unknown>;
    disconnectClient(id: string): Promise<unknown>;
  };
}

export async function startFtpServer(options: TestFtpServerOptions): Promise<TestFtpServer> {
  const username = options.username ?? 'user';
  const password = options.password ?? 'secret';
  const pasvMin = 20_000 + Math.floor(Math.random() * 20_000);
  const server = new FtpSrv({
    url: 'ftp://127.0.0.1:0',
    pasv_url: '127.0.0.1',
    pasv_min: pasvMin,
    pasv_max: pasvMin + 200,
    anonymous: false,
    log: silentLog,
  });

  server.on('login', (data, resolve, reject) => {
    if (data.username === username && data.password === password) {
      resolve({ root: options.root });
      return;
    }
    if (options.echoPasswordOnFailure) {
      reject(new Error(`login failed for secret ${data.password}`));
      return;
    }
    reject(new Error('login failed'));
  });

  await server.listen();
  const address = internal(server).server.address();
  if (!address || typeof address === 'string') {
    throw new Error('FTP server has no TCP address');
  }

  return {
    server,
    root: options.root,
    port: address.port,
    connectionIds(): string[] {
      return Object.keys(internal(server).connections);
    },
    async disconnectAll(): Promise<void> {
      await Promise.all(
        Object.keys(internal(server).connections).map((id) =>
          internal(server).disconnectClient(id),
        ),
      );
    },
    async close(): Promise<void> {
      await server.close();
    },
  };
}
