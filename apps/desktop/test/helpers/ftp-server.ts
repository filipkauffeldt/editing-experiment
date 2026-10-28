import type { AddressInfo } from 'node:net';
import { FtpSrv } from 'ftp-srv';

const silent = {
  trace: (): void => undefined,
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  fatal: (): void => undefined,
  child() {
    return silent;
  },
};

export interface TestFtpServer {
  root: string;
  port: number;
  close(): Promise<void>;
}

/** In-process FTP server rooted at `root`, listening on a free local port. */
export async function startFtpServer(options: {
  root: string;
  username: string;
  password: string;
}): Promise<TestFtpServer> {
  // ftp-srv adds a process-level signal handler per server and never removes it.
  process.setMaxListeners(Math.max(process.getMaxListeners(), 50));
  const pasvMin = 20_000 + Math.floor(Math.random() * 20_000);
  const server = new FtpSrv({
    url: 'ftp://127.0.0.1:0',
    pasv_url: '127.0.0.1',
    pasv_min: pasvMin,
    pasv_max: pasvMin + 200,
    anonymous: false,
    log: silent,
  });
  server.on('login', (data, resolve, reject) => {
    if (data.username === options.username && data.password === options.password) {
      resolve({ root: options.root });
    } else {
      reject(new Error('login failed'));
    }
  });
  await server.listen();
  const address = (
    server as unknown as { server: { address(): AddressInfo | string | null } }
  ).server.address();
  if (!address || typeof address === 'string') throw new Error('FTP server has no TCP address');
  return { root: options.root, port: address.port, close: () => server.close() };
}
