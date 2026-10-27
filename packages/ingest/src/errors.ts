/** Base class for ingest failures that callers may want to distinguish. */
export class IngestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

/** The copy on disk does not match the bytes read from the source. */
export class VerificationError extends IngestError {
  constructor(message: string) {
    super(message, 'verification-failed');
    this.name = 'VerificationError';
  }
}

/** A template tried to escape the destination directory. */
export class PathTraversalError extends IngestError {
  constructor(message: string) {
    super(message, 'path-traversal');
    this.name = 'PathTraversalError';
  }
}

/** A destination name already exists after exhausting collision suffixes. */
export class CollisionError extends IngestError {
  constructor(message: string) {
    super(message, 'collision');
    this.name = 'CollisionError';
  }
}

/** The run was stopped by its owner. */
export class IngestAbortError extends Error {
  constructor() {
    super('Ingest stopped');
    this.name = 'AbortError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof IngestAbortError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'IngestAbortError'))
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new IngestAbortError();
  }
}

/** Replaces credential material wherever it appears in a message. */
export function redactSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of [...secrets]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}
