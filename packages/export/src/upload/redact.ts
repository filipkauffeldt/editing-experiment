import type { CredentialSecret } from '@ee/contracts';

const REDACTED = '[redacted]';

/**
 * Removes credential material from a message before it is stored in the queue
 * database or emitted on the job event stream.
 */
export function redactSecrets(
  message: string,
  secret?: CredentialSecret,
  extraValues: readonly (string | undefined)[] = [],
): string {
  const values = [secret?.password, secret?.privateKey, secret?.passphrase, ...extraValues].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  let result = message;
  // Longest first so a key that contains another value is replaced whole.
  for (const value of values.sort((a, b) => b.length - a.length)) {
    result = result.split(value).join(REDACTED);
  }
  return result;
}

/** Turns an unknown thrown value into a safe, credential-free message. */
export function safeErrorMessage(
  error: unknown,
  secret?: CredentialSecret,
  extraValues: readonly (string | undefined)[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message, secret, extraValues).trim();
  return redacted.length > 0 ? redacted : 'Upload failed';
}
