import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { posix, resolve, sep } from 'node:path';
import {
  Server,
  utils,
  type Attributes,
  type Connection,
  type FileEntry,
  type SFTPWrapper,
} from 'ssh2';

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

type OpenHandle =
  | { kind: 'file'; data: Buffer; attrs: Attributes }
  | { kind: 'directory'; entries: FileEntry[]; sent: boolean };

export interface TestSftpServerOptions {
  root: string;
  username?: string;
  password?: string;
  /** Accept OPENDIR but never answer it, to exercise abort handling. */
  stallReadDir?: boolean;
}

export interface TestSftpServer {
  readonly root: string;
  readonly port: number;
  readonly hostKeyFingerprint: string;
  readdirRequests(): number;
  dropConnections(): void;
  close(): Promise<void>;
}

function localPath(root: string, remotePath: string): string {
  const relative = remotePath.replace(/^\/+/, '');
  const resolved = resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes the test SFTP root: ${remotePath}`);
  }
  return resolved;
}

function attributesFromMode(mode: number, size: number, mtimeMs: number): Attributes {
  const seconds = Math.floor(mtimeMs / 1000);
  return { mode, uid: 0, gid: 0, size, atime: seconds, mtime: seconds };
}

async function entryFor(directory: string, name: string, isDirectory: boolean): Promise<FileEntry> {
  const path = resolve(directory, name);
  const info = await stat(path);
  const attrs = attributesFromMode(isDirectory ? 0o040755 : 0o100644, info.size, info.mtimeMs);
  return {
    filename: name,
    longname: `${isDirectory ? 'd' : '-'}rwxr-xr-x 1 owner group ${info.size} Jan 1 00:00 ${name}`,
    attrs,
  };
}

function attachHandlers(
  sftp: SFTPWrapper,
  root: string,
  options: TestSftpServerOptions,
  state: { readdirRequests: number },
): void {
  const handles = new Map<string, OpenHandle>();
  let nextHandle = 1;

  const putHandle = (handle: OpenHandle): Buffer => {
    const id = String(nextHandle);
    nextHandle += 1;
    handles.set(id, handle);
    return Buffer.from(id);
  };

  const getHandle = (buffer: Buffer): OpenHandle | undefined => handles.get(buffer.toString());

  sftp.on('REALPATH', (reqid, path) => {
    const absolute = path.startsWith('/') ? posix.normalize(path) : posix.join('/', path);
    sftp.name(reqid, [
      {
        filename: absolute,
        longname: absolute,
        attrs: attributesFromMode(0o040755, 0, Date.now()),
      },
    ]);
  });

  sftp.on('STAT', (reqid, path) => {
    void stat(localPath(root, path))
      .then((info) => {
        sftp.attrs(
          reqid,
          attributesFromMode(info.isDirectory() ? 0o040755 : 0o100644, info.size, info.mtimeMs),
        );
      })
      .catch(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
  });

  sftp.on('LSTAT', (reqid, path) => {
    void stat(localPath(root, path))
      .then((info) => {
        sftp.attrs(
          reqid,
          attributesFromMode(info.isDirectory() ? 0o040755 : 0o100644, info.size, info.mtimeMs),
        );
      })
      .catch(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
  });

  sftp.on('FSTAT', (reqid, handle) => {
    const opened = getHandle(handle);
    if (!opened) {
      sftp.status(reqid, STATUS_CODE.FAILURE);
      return;
    }
    const attrs =
      opened.kind === 'file' ? opened.attrs : attributesFromMode(0o040755, 0, Date.now());
    sftp.attrs(reqid, attrs);
  });

  sftp.on('OPEN', (reqid, filename, flags, _attrs) => {
    if ((flags & OPEN_MODE.READ) === 0) {
      sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
      return;
    }
    const path = localPath(root, filename);
    void Promise.all([readFile(path), stat(path)])
      .then(([data, info]) => {
        if (info.isDirectory()) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        sftp.handle(
          reqid,
          putHandle({
            kind: 'file',
            data,
            attrs: attributesFromMode(0o100644, info.size, info.mtimeMs),
          }),
        );
      })
      .catch(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const opened = getHandle(handle);
    if (!opened || opened.kind !== 'file') {
      sftp.status(reqid, STATUS_CODE.FAILURE);
      return;
    }
    if (offset >= opened.data.length) {
      sftp.status(reqid, STATUS_CODE.EOF);
      return;
    }
    sftp.data(reqid, opened.data.subarray(offset, offset + length));
  });

  sftp.on('OPENDIR', (reqid, path) => {
    state.readdirRequests += 1;
    if (options.stallReadDir) {
      return;
    }
    const directory = localPath(root, path);
    void readdir(directory, { withFileTypes: true })
      .then(async (entries) => {
        const files = await Promise.all(
          entries.map((entry) => entryFor(directory, entry.name, entry.isDirectory())),
        );
        sftp.handle(reqid, putHandle({ kind: 'directory', entries: files, sent: false }));
      })
      .catch(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
  });

  sftp.on('READDIR', (reqid, handle) => {
    const opened = getHandle(handle);
    if (!opened || opened.kind !== 'directory') {
      sftp.status(reqid, STATUS_CODE.FAILURE);
      return;
    }
    if (opened.sent) {
      sftp.status(reqid, STATUS_CODE.EOF);
      return;
    }
    opened.sent = true;
    sftp.name(reqid, opened.entries);
  });

  sftp.on('CLOSE', (reqid, handle) => {
    handles.delete(handle.toString());
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('REMOVE', (reqid, path) => {
    void unlink(localPath(root, path))
      .then(() => sftp.status(reqid, STATUS_CODE.OK))
      .catch(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
  });

  sftp.on('SETSTAT', (reqid, _path, _attrs) => {
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('RENAME', (reqid, from, to) => {
    void rename(localPath(root, from), localPath(root, to))
      .then(() => sftp.status(reqid, STATUS_CODE.OK))
      .catch(() => sftp.status(reqid, STATUS_CODE.FAILURE));
  });

  sftp.on('MKDIR', (reqid, path, _attrs) => {
    void mkdir(localPath(root, path))
      .then(() => sftp.status(reqid, STATUS_CODE.OK))
      .catch(() => sftp.status(reqid, STATUS_CODE.FAILURE));
  });

  sftp.on('RMDIR', (reqid, path) => {
    void rm(localPath(root, path), { recursive: true })
      .then(() => sftp.status(reqid, STATUS_CODE.OK))
      .catch(() => sftp.status(reqid, STATUS_CODE.FAILURE));
  });
}

let cachedHostKey: string | undefined;

// ssh2's own ed25519 generator emits OpenSSH keys that its parser rejects
// ("Malformed OpenSSH private key") for roughly 1 in 300 random keys. RSA from
// node:crypto in PKCS#1 PEM parses every time; generate it once per process
// since RSA generation costs tens of milliseconds.
function sharedHostKey(): string {
  cachedHostKey ??= generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  return cachedHostKey;
}

export async function startSftpServer(options: TestSftpServerOptions): Promise<TestSftpServer> {
  const username = options.username ?? 'user';
  const password = options.password ?? 'secret';
  const hostKey = sharedHostKey();
  const parsedHostKey = utils.parseKey(hostKey);
  if (parsedHostKey instanceof Error) {
    throw parsedHostKey;
  }
  const hostKeyFingerprint = `SHA256:${createHash('sha256')
    .update(parsedHostKey.getPublicSSH())
    .digest('base64')
    .replace(/=+$/, '')}`;
  const clients: Connection[] = [];
  const state = { readdirRequests: 0 };

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.push(client);
    client.on('error', () => undefined);
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === username) {
        if (context.password === password) {
          context.accept();
        } else {
          context.reject();
        }
        return;
      }
      context.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          attachHandlers(acceptSftp(), options.root, options, state);
        });
      });
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('SFTP server has no TCP address');
  }

  return {
    root: options.root,
    port: (address as AddressInfo).port,
    hostKeyFingerprint,
    readdirRequests(): number {
      return state.readdirRequests;
    },
    dropConnections(): void {
      for (const client of clients.splice(0)) {
        client.end();
      }
    },
    async close(): Promise<void> {
      for (const client of clients.splice(0)) {
        client.end();
      }
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };
}
