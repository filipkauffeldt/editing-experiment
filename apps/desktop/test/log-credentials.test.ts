import {
  asSourceId,
  type CredentialSecret,
  type FtpSource,
  type IngestConfig,
} from '@ee/contracts';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { CredentialStore } from '../src/main/credentials';
import { RotatingLogFile } from '../src/main/log-file';
import { logJobEvent, type AppLog } from '../src/main/logging';
import { bridgeConsole } from '../src/shared/log-bridge';
import { startFtpServer, type TestFtpServer } from './helpers/ftp-server';

/**
 * What the real app does for a source with a password, end to end in plain Node: the credential
 * store hands the secret to the backend, the backend talks to a real FTP server that rejects the
 * login and echoes what it was given, and everything the app would keep (console warnings and
 * errors, `job.error` events) goes through the same log file. None of it may hold the password.
 */
const PASSWORD = 'Tr0ub4dor&3-horse-staple';
const USER = 'camera-user';

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(text, 'utf8'),
  decryptString: (data: Buffer) => data.toString('utf8'),
};

describe('credentials never reach the log file', () => {
  let root: string;
  let server: TestFtpServer;
  let backend: Backend;
  let log: AppLog;
  let logDir: string;
  const consoleWarn = console.warn;
  const consoleError = console.error;
  const jobErrors: string[] = [];

  const readLog = async (): Promise<string> => {
    const names = (await readdir(logDir)).sort();
    return (await Promise.all(names.map((name) => readFile(join(logDir, name), 'utf8')))).join('');
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-log-credentials-'));
    logDir = join(root, 'userdata', 'logs');
    const file = new RotatingLogFile({ dir: logDir, maxBytes: 1_000_000, maxFiles: 3 });
    log = {
      file,
      write: (source, level, message) => file.write(source, level, message),
      addSecrets: (values) => file.redactor.addSecrets(values),
    };
    // The same wiring as main/index.ts: the store reports each secret, the console is bridged.
    const store = new CredentialStore(
      join(root, 'userdata', 'credentials.json'),
      fakeSafeStorage,
      () => {},
      (secret) => log.addSecrets([secret.password, secret.privateKey, secret.passphrase]),
    );
    store.set({ password: PASSWORD } satisfies CredentialSecret, 'camera-ftp');
    bridgeConsole(console, (level, message) => log.write('jobs', level, message));

    const remote = join(root, 'remote');
    await mkdir(remote);
    server = await startFtpServer({
      root: remote,
      username: USER,
      password: 'the-real-one',
      echoRejectedLogin: true,
    });
    backend = await createBackend({
      userDataDir: join(root, 'userdata'),
      appVersion: 'test',
      homeDir: root,
      emit: (channel, payload) => {
        const event = payload as { type?: string; message?: string };
        if (channel === 'jobs:event' && event.type === 'job.error') {
          jobErrors.push(event.message ?? '');
        }
        logJobEvent(log, channel, payload);
      },
      getSecret: async (ref) => store.get(ref),
    });
  }, 60_000);

  afterAll(async () => {
    console.warn = consoleWarn;
    console.error = consoleError;
    await backend?.handlers['ingest:stop']?.();
    await backend?.dispose();
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('keeps the password out of a failed FTP ingest, the test button and the console', async () => {
    const source: FtpSource = {
      id: asSourceId('camera-ftp'),
      name: 'Camera body',
      kind: 'ftp',
      host: '127.0.0.1',
      port: server.port,
      username: USER,
      credentialRef: 'camera-ftp',
      remotePath: '/',
      pollIntervalMs: 200,
      deleteAfterDownload: false,
      security: 'none',
    };
    const config: IngestConfig = {
      sources: [source],
      destination: { path: join(root, 'ingest') },
      fileNaming: 'rename',
      renameTemplate: '{sourceName}_{seq:3}',
    };
    const tested = await backend.handlers['sources:test']!({ source });
    expect(tested).toMatchObject({ ok: false });
    await backend.handlers['ingest:start']!({ config });
    await vi.waitFor(() => expect(jobErrors.length).toBeGreaterThan(0), { timeout: 20_000 });
    // What a failed run in the app logs when it falls over for some other reason: the same
    // message with the credential inside it, from code that does not redact on its own.
    console.warn(`ftp://${USER}:${PASSWORD}@127.0.0.1:${server.port}/ could not be listed`);
    console.error(new Error(`connect failed, password=${PASSWORD}`));

    const text = await readLog();
    expect(text).toContain('ERROR [jobs] ingest: 530 login failed');
    expect(text).toContain('could not be listed');
    expect(jobErrors.join('\n')).not.toContain(PASSWORD);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('the-real-one');
    // The user name is part of the URL's credentials; the host stays so the line is still useful.
    expect(text).not.toContain(`${USER}:`);
    expect(text).toContain('127.0.0.1');
  }, 60_000);
});
