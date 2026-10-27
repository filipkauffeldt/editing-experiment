import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  Server,
  utils,
  type Attributes,
  type Connection,
  type FileEntry,
  type SFTPWrapper,
} from 'ssh2';
import { sha256Fingerprint } from '../../src/upload/connectors/sftp';

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

export interface SftpTestServer {
  port: number;
  fingerprint: string;
  root: string;
  username: string;
  password: string;
  dropCount(): number;
  close(): Promise<void>;
}

interface OpenFile {
  fd: number;
  remotePath: string;
}

interface DropState {
  remaining: number;
  afterBytes: number;
  count: number;
}

export async function startSftpServer(options: {
  root: string;
  username?: string;
  password?: string;
  dropAfterBytes?: number;
}): Promise<SftpTestServer> {
  const username = options.username ?? 'photo';
  const password = options.password ?? 's3cret-sftp-pass';
  await mkdir(options.root, { recursive: true });

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key === undefined) throw new Error('Could not parse generated host key');
  const fingerprint = sha256Fingerprint(key.getPublicSSH());

  const dropState: DropState | undefined =
    options.dropAfterBytes === undefined
      ? undefined
      : { remaining: 1, afterBytes: options.dropAfterBytes, count: 0 };

  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('error', () => undefined);
    client.on('close', () => clients.delete(client));

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') {
        ctx.reject();
        return;
      }
      if (ctx.username !== username || ctx.password !== password) {
        ctx.reject();
        return;
      }
      ctx.accept();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          attachSftp(acceptSftp(), options.root, client, dropState);
        });
      });
    });
  });

  server.on('error', () => undefined);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    fingerprint,
    root: options.root,
    username,
    password,
    dropCount: () => dropState?.count ?? 0,
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function attachSftp(
  sftp: SFTPWrapper,
  root: string,
  client: Connection,
  dropState: DropState | undefined,
): void {
  const openFiles = new Map<number, OpenFile>();
  let handleCount = 0;
  let written = 0;

  sftp.on('REALPATH', (reqId: number, requested: string) => {
    const entry = resolve(root, requested);
    sftp.name(reqId, [fileEntry(entry.remote, directoryAttrs())]);
  });

  sftp.on('OPEN', (reqId: number, filename: string, flags: number, _attrs: Attributes) => {
    const entry = resolve(root, filename);
    const flagString = openFlags(flags);
    fs.open(entry.local, flagString, (error, fd) => {
      if (error !== null) {
        sftp.status(
          reqId,
          error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE,
        );
        return;
      }
      const handleNumber = handleCount++;
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(handleNumber, 0);
      openFiles.set(handleNumber, { fd, remotePath: entry.remote });
      sftp.handle(reqId, handle);
    });
  });

  sftp.on('WRITE', (reqId: number, handle: Buffer, offset: number, data: Buffer) => {
    const open = lookup(openFiles, handle);
    if (open === undefined) {
      sftp.status(reqId, STATUS_CODE.FAILURE);
      return;
    }

    written += data.length;
    if (dropState !== undefined && dropState.remaining > 0 && written > dropState.afterBytes) {
      dropState.remaining--;
      dropState.count++;
      destroyClient(client);
      return;
    }

    fs.write(open.fd, data, 0, data.length, offset, (error) => {
      sftp.status(reqId, error === null ? STATUS_CODE.OK : STATUS_CODE.FAILURE);
    });
  });

  sftp.on('CLOSE', (reqId: number, handle: Buffer) => {
    const open = lookup(openFiles, handle);
    if (open === undefined) {
      sftp.status(reqId, STATUS_CODE.FAILURE);
      return;
    }
    const handleNumber = handle.readUInt32BE(0);
    openFiles.delete(handleNumber);
    fs.close(open.fd, () => sftp.status(reqId, STATUS_CODE.OK));
  });

  sftp.on('FSTAT', (reqId: number, handle: Buffer) => {
    const open = lookup(openFiles, handle);
    if (open === undefined) {
      sftp.status(reqId, STATUS_CODE.FAILURE);
      return;
    }
    fs.fstat(open.fd, (error, stats) => {
      if (error !== null) sftp.status(reqId, STATUS_CODE.FAILURE);
      else sftp.attrs(reqId, toAttrs(stats));
    });
  });

  const respondStat =
    (follow: boolean) =>
    (reqId: number, requested: string): void => {
      const entry = resolve(root, requested);
      const callback = (error: NodeJS.ErrnoException | null, stats: fs.Stats): void => {
        if (error !== null) {
          sftp.status(
            reqId,
            error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE,
          );
          return;
        }
        sftp.attrs(reqId, toAttrs(stats));
      };
      if (follow) fs.stat(entry.local, callback);
      else fs.lstat(entry.local, callback);
    };
  sftp.on('STAT', respondStat(true));
  sftp.on('LSTAT', respondStat(false));

  sftp.on('MKDIR', (reqId: number, requested: string, _attrs: Attributes) => {
    const entry = resolve(root, requested);
    fs.mkdir(entry.local, { recursive: true }, (error) => {
      sftp.status(
        reqId,
        error === null || error.code === 'EEXIST' ? STATUS_CODE.OK : STATUS_CODE.FAILURE,
      );
    });
  });

  sftp.on('RENAME', (reqId: number, from: string, to: string) => {
    fs.rename(resolve(root, from).local, resolve(root, to).local, (error) => {
      sftp.status(reqId, error === null ? STATUS_CODE.OK : STATUS_CODE.FAILURE);
    });
  });

  sftp.on('SETSTAT', (reqId: number) => {
    sftp.status(reqId, STATUS_CODE.OK);
  });
}

function openFlags(flags: number): string {
  if ((flags & OPEN_MODE.APPEND) !== 0) return 'a';
  if ((flags & OPEN_MODE.WRITE) !== 0) {
    return (flags & OPEN_MODE.READ) !== 0 ? 'r+' : 'w';
  }
  return 'r';
}

function lookup(openFiles: Map<number, OpenFile>, handle: Buffer): OpenFile | undefined {
  if (handle.length !== 4) return undefined;
  return openFiles.get(handle.readUInt32BE(0));
}

function resolve(root: string, requested: string): { remote: string; local: string } {
  const remote = path.posix.normalize(`/${requested.replace(/\\/g, '/')}`);
  const local = path.resolve(root, `.${remote}`);
  if (local !== root && !local.startsWith(root + path.sep)) {
    throw new Error(`Path escapes test root: ${requested}`);
  }
  return { remote, local };
}

function toAttrs(stats: fs.Stats): Attributes {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function directoryAttrs(): Attributes {
  return { mode: fs.constants.S_IFDIR | 0o755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
}

function fileEntry(filename: string, attrs: Attributes): FileEntry {
  return { filename, longname: filename, attrs };
}

function destroyClient(client: Connection): void {
  const socket = (client as unknown as { _sock?: { destroy(): void } })._sock;
  if (socket !== undefined) socket.destroy();
  else client.end();
}
