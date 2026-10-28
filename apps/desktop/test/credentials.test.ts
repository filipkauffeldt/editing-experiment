import { IpcError } from '@ee/contracts';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialStore, credentialHandlers, type SafeStorageLike } from '../src/main/credentials';
import {
  createSecretClient,
  nodeSecretPort,
  serveSecrets,
  type SecretPort,
} from '../src/shared/secret-port';

/** Stands in for the OS keyring: reversible, but unreadable without going through the API. */
function fakeSafeStorage(options: { available?: boolean; backend?: string } = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    ...(options.backend === undefined ? {} : { getSelectedStorageBackend: () => options.backend! }),
    encryptString: (text) =>
      Buffer.from(
        Buffer.from(text, 'utf8')
          .reverse()
          .map((b) => b ^ 0x5a),
      ),
    decryptString: (data) =>
      Buffer.from(Buffer.from(data).map((b) => b ^ 0x5a))
        .reverse()
        .toString('utf8'),
  };
}

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-cred-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CredentialStore', () => {
  it('stores secrets encrypted on disk and reads them back', async () => {
    const dir = await tempDir();
    const file = join(dir, 'credentials.json');
    const store = new CredentialStore(file, fakeSafeStorage());

    const ref = store.set({ password: 'hunter2-plain' });
    expect(ref).toMatch(/^cred-/);
    expect(await readFile(file, 'utf8')).not.toContain('hunter2');

    // A new process reads the same file.
    const reopened = new CredentialStore(file, fakeSafeStorage());
    expect(reopened.get(ref)).toEqual({ password: 'hunter2-plain' });
  });

  it('keeps the given reference and replaces the secret behind it', async () => {
    const store = new CredentialStore(join(await tempDir(), 'c.json'), fakeSafeStorage());
    expect(store.set({ password: 'one' }, 'ftp-main')).toBe('ftp-main');
    store.set({ password: 'two' }, 'ftp-main');
    expect(store.get('ftp-main')).toEqual({ password: 'two' });
  });

  it('refuses to store anything when the OS cannot encrypt, and writes no file', async () => {
    const dir = await tempDir();
    const file = join(dir, 'credentials.json');
    for (const storage of [
      fakeSafeStorage({ available: false }),
      fakeSafeStorage({ available: true, backend: 'basic_text' }),
    ]) {
      const store = new CredentialStore(file, storage);
      expect(() => store.set({ password: 'nope' })).toThrowError(IpcError);
      expect(() => store.set({ password: 'nope' })).toThrowError(/keyring/);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes secrets, and removing an unknown reference is fine', async () => {
    const store = new CredentialStore(join(await tempDir(), 'c.json'), fakeSafeStorage());
    const ref = store.set({ password: 'x' });
    store.remove(ref);
    store.remove('never-existed');
    expect(() => store.get(ref)).toThrowError(/no credential/);
  });

  it('rejects empty secrets and malformed references', async () => {
    const store = new CredentialStore(join(await tempDir(), 'c.json'), fakeSafeStorage());
    expect(() => store.set({})).toThrowError(/password or a private key/);
    expect(() => store.set({ password: 'x' }, '../escape')).toThrowError(/invalid characters/);
  });

  it('exposes only set and remove to the renderer', async () => {
    const store = new CredentialStore(join(await tempDir(), 'c.json'), fakeSafeStorage());
    const handlers = credentialHandlers(store);
    expect(Object.keys(handlers).sort()).toEqual(['credentials:remove', 'credentials:set']);
    const { ref } = await handlers['credentials:set']({ secret: { privateKey: 'PEM' } });
    expect(store.get(ref)).toEqual({ privateKey: 'PEM' });
  });
});

describe('secrets port', () => {
  function connect(lookup: (ref: string) => Promise<{ password?: string }>) {
    const { port1, port2 } = new MessageChannel();
    serveSecrets(nodeSecretPort(port1), lookup);
    const client = createSecretClient(Promise.resolve(nodeSecretPort(port2)), { timeoutMs: 300 });
    return { client, close: () => (port1.close(), port2.close()) };
  }

  it('answers getSecret(ref) over the private port', async () => {
    const { client, close } = connect(async (ref) => ({ password: `pw-for-${ref}` }));
    await expect(client('a')).resolves.toEqual({ password: 'pw-for-a' });
    await expect(Promise.all([client('b'), client('c')])).resolves.toEqual([
      { password: 'pw-for-b' },
      { password: 'pw-for-c' },
    ]);
    close();
  });

  it('turns lookup failures into IpcErrors without leaking details', async () => {
    const { client, close } = connect(async (ref) => {
      if (ref === 'missing') throw new IpcError('not_found', 'no credential stored for "missing"');
      throw new Error('boom with hunter2 inside');
    });
    await expect(client('missing')).rejects.toMatchObject({ code: 'not_found' });
    const error = await client('other').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'internal' });
    expect((error as Error).message).not.toContain('hunter2');
    close();
  });

  it('waits for the port to arrive and times out when nobody answers', async () => {
    let deliver: (port: SecretPort) => void = () => {};
    const port = new Promise<SecretPort>((resolve) => (deliver = resolve));
    const client = createSecretClient(port, { timeoutMs: 100 });
    const pending = client('late');
    const { port1, port2 } = new MessageChannel();
    serveSecrets(nodeSecretPort(port1), async () => ({ password: 'ok' }));
    deliver(nodeSecretPort(port2));
    await expect(pending).resolves.toEqual({ password: 'ok' });

    const silent = new MessageChannel();
    const quiet = createSecretClient(Promise.resolve(nodeSecretPort(silent.port2)), {
      timeoutMs: 50,
    });
    await expect(quiet('x')).rejects.toThrowError(/timed out/);
    for (const p of [port1, port2, silent.port1, silent.port2]) p.close();
  });
});
