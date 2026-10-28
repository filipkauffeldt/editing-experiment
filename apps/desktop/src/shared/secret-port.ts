import { IpcError, type CredentialSecret, type IpcErrorShape } from '@ee/contracts';

/**
 * Private request/response channel between main (which owns the encrypted
 * secrets, see `main/credentials.ts`) and the jobs process (which connects to
 * servers). Secrets never go through the renderer, and are only sent on request.
 *
 * The two sides see different port classes: Electron's `MessagePortMain` hands
 * listeners `{ data }`, Node's `MessagePort` hands them the value itself. A
 * {@link SecretPort} hides that difference so the logic can be tested in Node.
 */
export interface SecretPort {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

/** Adapt Electron's `MessagePortMain` (main and utility process). */
export function electronSecretPort(port: {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  start(): void;
}): SecretPort {
  return {
    send: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', (event) => listener(event.data));
      port.start();
    },
  };
}

/** Adapt a `node:worker_threads` `MessagePort` (tests). */
export function nodeSecretPort(port: {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
}): SecretPort {
  return {
    send: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', listener);
    },
  };
}

interface SecretRequest {
  kind: 'get-secret';
  id: number;
  ref: string;
}

type SecretReply =
  | { kind: 'secret'; id: number; secret: CredentialSecret }
  | { kind: 'secret'; id: number; error: IpcErrorShape };

const isRequest = (message: unknown): message is SecretRequest =>
  typeof message === 'object' &&
  message !== null &&
  (message as { kind?: unknown }).kind === 'get-secret';

const isReply = (message: unknown): message is SecretReply =>
  typeof message === 'object' &&
  message !== null &&
  (message as { kind?: unknown }).kind === 'secret';

/** Main side: answer `getSecret(ref)` requests from `lookup`. */
export function serveSecrets(
  port: SecretPort,
  lookup: (ref: string) => Promise<CredentialSecret>,
): void {
  port.onMessage((message) => {
    if (!isRequest(message)) return;
    const { id, ref } = message;
    lookup(ref).then(
      (secret) => port.send({ kind: 'secret', id, secret } satisfies SecretReply),
      (error: unknown) => {
        const shape: IpcErrorShape =
          error instanceof IpcError
            ? error.toShape()
            : { code: 'internal', message: 'secret lookup failed' };
        port.send({ kind: 'secret', id, error: shape } satisfies SecretReply);
      },
    );
  });
}

/**
 * Jobs side: `getSecret(ref)` over the port. Pass the port as a promise because
 * main delivers it right after the process starts; requests wait for it.
 */
export function createSecretClient(
  port: Promise<SecretPort>,
  options: { timeoutMs?: number } = {},
): (ref: string) => Promise<CredentialSecret> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pending = new Map<
    number,
    { resolve(secret: CredentialSecret): void; reject(error: unknown): void }
  >();
  let nextId = 1;
  void port.then((resolved) =>
    resolved.onMessage((message) => {
      if (!isReply(message)) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if ('error' in message) entry.reject(new IpcError(message.error.code, message.error.message));
      else entry.resolve(message.secret);
    }),
  );

  return async (ref) => {
    const resolved = await port;
    const id = nextId++;
    return new Promise<CredentialSecret>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new IpcError('internal', `timed out waiting for credential "${ref}"`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (secret) => {
          clearTimeout(timer);
          resolve(secret);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      resolved.send({ kind: 'get-secret', id, ref } satisfies SecretRequest);
    });
  };
}
