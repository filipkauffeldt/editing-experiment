import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asDestinationId, type FtpDestination, type SftpDestination } from '@ee/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NonRetryableUploadError } from '../src/errors';
import { connectionOutage, isConnectionOutage, outageReason } from '../src/upload/outage';
import type { UploadRequest } from '../src/upload/types';
import { createFtpConnector, createSftpConnector } from '../src/upload/connectors';
import { startFtpServer, type FtpTestServer } from './helpers/ftp-server';
import { startSftpServer, type SftpTestServer } from './helpers/sftp-server';

const withCode = (message: string, code: string | number): Error =>
  Object.assign(new Error(message), { code });

function ftpDestination(port: number): FtpDestination {
  return {
    id: asDestinationId('outage-ftp'),
    name: 'FTP',
    kind: 'ftp',
    host: '127.0.0.1',
    port,
    username: 'photo',
    credentialRef: 'cred',
    security: 'none',
    remotePathTemplate: 'in/{fileName}',
  };
}

function sftpDestination(port: number, fingerprint: string): SftpDestination {
  return {
    id: asDestinationId('outage-sftp'),
    name: 'SFTP',
    kind: 'sftp',
    host: '127.0.0.1',
    port,
    username: 'photo',
    credentialRef: 'cred',
    hostKeyFingerprint: fingerprint,
    remotePathTemplate: 'in/{fileName}',
  };
}

function request(
  destination: FtpDestination | SftpDestination,
  localPath: string,
  password: string,
): UploadRequest {
  return {
    destination,
    uploadId: 'outage-upload' as UploadRequest['uploadId'],
    claimToken: 'claim-token',
    localPath,
    remotePath: 'in/frame.jpg',
    bytesTotal: 1024 * 1024,
    secret: { password },
    signal: new AbortController().signal,
    report: () => undefined,
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the transfer to fail');
}

describe('connection outage classification', () => {
  let dir: string;
  let ftp: FtpTestServer | undefined;
  let sftp: SftpTestServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-outage-'));
  });

  afterEach(async () => {
    await sftp?.close();
    sftp = undefined;
    await ftp?.close();
    ftp = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const localFile = async (name: string, size = 1024): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, Buffer.alloc(size, 4));
    return file;
  };

  it('does not classify the failures this package raises itself', () => {
    expect(isConnectionOutage(new NonRetryableUploadError('invalid_path', 'not a file'))).toBe(
      false,
    );
    expect(isConnectionOutage(new Error('Upload cancelled'))).toBe(false);
  });

  it('classifies a refused connection, a reset connection and a timeout', () => {
    expect(connectionOutage(withCode('connect ECONNREFUSED 10.0.0.1:21', 'ECONNREFUSED'))).toBe(
      'unreachable',
    );
    expect(connectionOutage(withCode('read ECONNRESET', 'ECONNRESET'))).toBe('lost');
    expect(connectionOutage(withCode('connect ETIMEDOUT', 'ETIMEDOUT'))).toBe('timeout');
    expect(connectionOutage(withCode('getaddrinfo ENOTFOUND pool.example', 'ENOTFOUND'))).toBe(
      'unreachable',
    );
    expect(connectionOutage(withCode('connect ENETUNREACH', 'ENETUNREACH'))).toBe('unreachable');
  });

  it('classifies a lost control or data connection without an errno code', () => {
    expect(
      connectionOutage(new Error('Server sent FIN packet unexpectedly, closing connection.')),
    ).toBe('lost');
    expect(connectionOutage(new Error('Timeout (control socket)'))).toBe('timeout');
    expect(connectionOutage(new Error('Timeout (data socket)'))).toBe('timeout');
    expect(
      connectionOutage(new Error('getConnection: Timed out while waiting for handshake')),
    ).toBe('timeout');
    expect(connectionOutage(new Error('getConnection: Connection lost'))).toBe('lost');
    expect(connectionOutage(new Error('Client is closed because read ECONNRESET'))).toBe('lost');
  });

  it('classifies FTP replies that only ask for a later try', () => {
    expect(connectionOutage(withCode('425 Can not open data connection', 425))).toBe('unreachable');
    expect(connectionOutage(withCode('426 Connection closed; transfer aborted', 426))).toBe('lost');
  });

  it('keeps a login failure, a missing file and a bad path as real failures', () => {
    expect(connectionOutage(withCode('530 Invalid username or password', 530))).toBeUndefined();
    expect(connectionOutage(withCode('530 Login incorrect', 530))).toBeUndefined();
    expect(connectionOutage(withCode('553 File name not allowed', 553))).toBeUndefined();
    // A reply code decides, whatever the server's wording says.
    expect(connectionOutage(withCode('550 Permission denied: timeout', 550))).toBeUndefined();
    expect(connectionOutage(withCode('550 Connection closed by server', 550))).toBeUndefined();
    expect(
      connectionOutage(new Error('getConnection: All configured authentication methods failed')),
    ).toBeUndefined();
    expect(
      connectionOutage(withCode("ENOENT: no such file or directory, open '/x.jpg'", 'ENOENT')),
    ).toBeUndefined();
    expect(connectionOutage(withCode('mkdir: Bad path: /in already exists as a file', -2))).toBe(
      undefined,
    );
    expect(connectionOutage(withCode('permission denied', 'EACCES'))).toBeUndefined();
    expect(
      connectionOutage(withCode('self signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT')),
    ).toBe(undefined);
  });

  it('uses plain words for the popover', () => {
    expect(outageReason('unreachable')).toBe('Cannot reach the server');
    expect(outageReason('lost')).toBe('The connection was lost');
    expect(outageReason('timeout')).toBe('The server did not answer in time');
  });

  it('classifies a real refused FTP connection and a real refused SFTP connection', async () => {
    const localPath = await localFile('refused.jpg');
    ftp = await startFtpServer({ root: path.join(dir, 'ftp-closed') });
    const ftpPort = ftp.port;
    const ftpPassword = ftp.password;
    await ftp.close();
    ftp = undefined;
    const ftpError = await failureOf(() =>
      createFtpConnector(ftpDestination(ftpPort)).upload(
        request(ftpDestination(ftpPort), localPath, ftpPassword),
      ),
    );
    expect(isConnectionOutage(ftpError)).toBe(true);

    sftp = await startSftpServer({ root: path.join(dir, 'sftp-closed') });
    const sftpPort = sftp.port;
    const fingerprint = sftp.fingerprint;
    const password = sftp.password;
    await sftp.close();
    sftp = undefined;
    const sftpError = await failureOf(() =>
      createSftpConnector(sftpDestination(sftpPort, fingerprint)).upload(
        request(sftpDestination(sftpPort, fingerprint), localPath, password),
      ),
    );
    expect(isConnectionOutage(sftpError)).toBe(true);
  });

  it('classifies a real mid-transfer drop on FTP and SFTP', async () => {
    const localPath = await localFile('drop.jpg', 256 * 1024);
    ftp = await startFtpServer({
      root: path.join(dir, 'ftp-drop'),
      dropAfterBytes: 48 * 1024,
    });
    const ftpError = await failureOf(() =>
      createFtpConnector(ftpDestination(ftp!.port)).upload(
        request(ftpDestination(ftp!.port), localPath, ftp!.password),
      ),
    );
    expect(isConnectionOutage(ftpError)).toBe(true);
    expect(ftp.dropCount()).toBe(1);
    await ftp.close();
    ftp = undefined;

    sftp = await startSftpServer({
      root: path.join(dir, 'sftp-drop'),
      dropAfterBytes: 48 * 1024,
    });
    const sftpError = await failureOf(() =>
      createSftpConnector(sftpDestination(sftp!.port, sftp!.fingerprint)).upload(
        request(sftpDestination(sftp!.port, sftp!.fingerprint), localPath, sftp!.password),
      ),
    );
    expect(isConnectionOutage(sftpError)).toBe(true);
    expect(sftp.dropCount()).toBe(1);
  });

  it('does not call a wrong password an outage', async () => {
    const localPath = await localFile('denied.jpg');
    ftp = await startFtpServer({ root: path.join(dir, 'ftp-auth') });
    const ftpError = await failureOf(() =>
      createFtpConnector(ftpDestination(ftp!.port)).upload(
        request(ftpDestination(ftp!.port), localPath, 'wrong password'),
      ),
    );
    expect(isConnectionOutage(ftpError)).toBe(false);

    sftp = await startSftpServer({ root: path.join(dir, 'sftp-auth') });
    const sftpError = await failureOf(() =>
      createSftpConnector(sftpDestination(sftp!.port, sftp!.fingerprint)).upload(
        request(sftpDestination(sftp!.port, sftp!.fingerprint), localPath, 'wrong password'),
      ),
    );
    expect(isConnectionOutage(sftpError)).toBe(false);
  });

  it('does not call a local file that is gone an outage', async () => {
    ftp = await startFtpServer({ root: path.join(dir, 'ftp-missing') });
    const missing = path.join(dir, 'missing.jpg');
    const error = await failureOf(() =>
      createFtpConnector(ftpDestination(ftp!.port)).upload(
        request(ftpDestination(ftp!.port), missing, ftp!.password),
      ),
    );
    expect(isConnectionOutage(error)).toBe(false);
  });
});
