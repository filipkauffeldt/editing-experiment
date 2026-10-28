import { mkdir } from 'node:fs/promises';
import type { AddressInfo, Server as NetServer } from 'node:net';
import type { WriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import FtpSrv, { FileSystem } from 'ftp-srv';
import type { FtpConnection } from 'ftp-srv';

export interface FtpTestServer {
  port: number;
  root: string;
  username: string;
  password: string;
  /** How many transfers were deliberately dropped. */
  dropCount(): number;
  close(): Promise<void>;
}

interface DropState {
  remaining: number;
  afterBytes: number;
  count: number;
}

interface SilentLog {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  child: () => SilentLog;
}

const silentLog: SilentLog = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  debug: (): void => undefined,
  trace: (): void => undefined,
  child: (): SilentLog => silentLog,
};

class DroppingFileSystem extends FileSystem {
  constructor(
    connection: FtpConnection,
    root: string,
    private readonly drop: DropState | undefined,
  ) {
    super(connection, { root, cwd: '/' });
  }

  override write(
    fileName: string,
    options: { append?: boolean; start?: number } = {},
  ): { stream: Transform | WriteStream; clientPath: string } {
    const response = super.write(fileName, options) as {
      stream: Transform | WriteStream;
      clientPath: string;
    };
    if (this.drop === undefined || this.drop.remaining <= 0) {
      return response;
    }

    this.drop.remaining--;
    let sent = 0;
    let dropped = false;
    const connection = this.connection;
    const drop = this.drop;
    const closable = connection as unknown as {
      close(code: number): Promise<unknown>;
    };

    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        sent += chunk.length;
        if (!dropped && sent > drop.afterBytes) {
          dropped = true;
          drop.count++;
          response.stream.destroy();
          setImmediate(() => {
            void closable.close(0).catch(() => undefined);
          });
          callback(new Error('simulated mid-transfer connection drop'));
          return;
        }
        if (response.stream.write(chunk)) callback();
        else response.stream.once('drain', () => callback());
      },
      final(callback): void {
        response.stream.end(() => callback());
      },
    });

    return { stream, clientPath: response.clientPath };
  }
}

export async function startFtpServer(options: {
  root: string;
  username?: string;
  password?: string;
  dropAfterBytes?: number;
}): Promise<FtpTestServer> {
  const username = options.username ?? 'photo';
  const password = options.password ?? 's3cret-photo-pass';
  const dropState: DropState | undefined =
    options.dropAfterBytes === undefined
      ? undefined
      : { remaining: 1, afterBytes: options.dropAfterBytes, count: 0 };

  const server = new FtpSrv({
    url: 'ftp://127.0.0.1:0',
    pasv_url: '127.0.0.1',
    anonymous: false,
    log: silentLog,
  });

  server.on(
    'login',
    ({ connection, username: givenUser, password: givenPassword }, resolve, reject) => {
      if (givenUser !== username || givenPassword !== password) {
        reject(new Error('Invalid username or password'));
        return;
      }
      resolve({ fs: new DroppingFileSystem(connection, options.root, dropState) });
    },
  );
  server.on('client-error', () => undefined);

  await mkdir(options.root, { recursive: true });
  await server.listen();
  const address = (server as unknown as { server: NetServer }).server.address() as AddressInfo;

  return {
    port: address.port,
    root: options.root,
    username,
    password,
    dropCount: () => dropState?.count ?? 0,
    close: async () => {
      await server.close();
    },
  };
}
