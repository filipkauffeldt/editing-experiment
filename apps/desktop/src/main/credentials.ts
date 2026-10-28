import { IpcError, type CredentialSecret, type NamespaceHandlers } from '@ee/contracts';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { writeJsonAtomic } from '../jobs/backend/atomic-json';

/** The part of Electron's `safeStorage` the store uses (a fake stands in for it in tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only. `basic_text` means no keyring: "encrypted" with a key anyone can read. */
  getSelectedStorageBackend?(): string;
}

const UNAVAILABLE =
  'Secure credential storage is not available on this system (no OS keyring was found). ' +
  'Install and unlock a keyring such as GNOME Keyring or KWallet, then try again. ' +
  'Credentials are never stored unencrypted.';

const REF_PATTERN = /^[\w.:-]{1,128}$/;

interface Stored {
  version: 1;
  /** `credentialRef` → base64 of the `safeStorage`-encrypted JSON secret. */
  entries: Record<string, string>;
}

/**
 * Encrypted secrets for sources and destinations, persisted in userData.
 * Only ciphertext reaches disk; if `safeStorage` cannot encrypt, nothing is
 * stored (there is no plaintext fallback). Secrets are never logged.
 */
export class CredentialStore {
  private entries: Record<string, string>;

  /**
   * @param onWarning told when an unreadable file was set aside; the message never
   *   contains file contents
   */
  constructor(
    private readonly file: string,
    private readonly safeStorage: SafeStorageLike,
    onWarning: (message: string) => void = () => {},
  ) {
    this.entries = {};
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>;
      const entries = parsed?.entries;
      if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        throw new Error('unexpected structure');
      }
      this.entries = entries;
    } catch {
      // Starting without stored credentials beats not starting; the user can enter them again.
      const aside = `${file}.corrupt-${Date.now()}`;
      renameSync(file, aside);
      onWarning(
        `The saved credentials file could not be read and was moved to ${aside}. ` +
          'Passwords have to be entered again.',
      );
    }
  }

  private assertAvailable(): void {
    const backend = this.safeStorage.getSelectedStorageBackend?.();
    if (
      !this.safeStorage.isEncryptionAvailable() ||
      backend === 'basic_text' ||
      backend === 'unknown'
    ) {
      throw new IpcError('auth', UNAVAILABLE);
    }
  }

  /** Store (or replace, when `ref` exists) a secret and return its reference. */
  set(secret: CredentialSecret, ref?: string): string {
    this.assertAvailable();
    if (!secret.password && !secret.privateKey) {
      throw new IpcError('invalid_argument', 'a credential needs a password or a private key');
    }
    const key = ref || `cred-${randomUUID()}`;
    if (!REF_PATTERN.test(key)) {
      throw new IpcError('invalid_argument', 'credential reference has invalid characters');
    }
    const encrypted = this.safeStorage.encryptString(JSON.stringify(secret));
    this.entries = { ...this.entries, [key]: encrypted.toString('base64') };
    this.save();
    return key;
  }

  get(ref: string): CredentialSecret {
    this.assertAvailable();
    const encoded = this.entries[ref];
    if (encoded === undefined) {
      throw new IpcError('not_found', `no credential stored for "${ref}"`);
    }
    try {
      return JSON.parse(
        this.safeStorage.decryptString(Buffer.from(encoded, 'base64')),
      ) as CredentialSecret;
    } catch {
      // The keyring may have been reset; never echo anything from the ciphertext.
      throw new IpcError('auth', `the credential "${ref}" could not be decrypted; enter it again`);
    }
  }

  remove(ref: string): void {
    if (!(ref in this.entries)) return;
    const rest = { ...this.entries };
    delete rest[ref];
    this.entries = rest;
    this.save();
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, entries: this.entries } satisfies Stored, 0o600);
  }
}

/** `credentials:*` for the renderer. Write-only: there is no channel that returns a secret. */
export function credentialHandlers(store: CredentialStore): NamespaceHandlers<'credentials'> {
  return {
    'credentials:set': async ({ secret, ref }) => ({ ref: store.set(secret, ref) }),
    'credentials:remove': async ({ ref }) => store.remove(ref),
  };
}
