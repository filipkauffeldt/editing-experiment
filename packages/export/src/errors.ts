export type ExportErrorCode =
  | 'invalid_image'
  | 'invalid_preset'
  | 'invalid_file_name'
  | 'invalid_path'
  | 'target_exists'
  | 'embedded_preview'
  | 'missing_credentials'
  | 'unsupported_destination'
  | 'upload_not_found'
  | 'upload_invalid_state'
  | 'upload_cancelled'
  | 'host_key_unpinned'
  | 'host_key_mismatch'
  | 'remote_exists';

/** Base class for errors raised by this package. Messages never contain secrets. */
export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExportError';
    this.code = code;
  }
}

/**
 * Failure that retrying cannot fix (bad credentials, an unpinned or mismatched
 * host key, an existing remote file, an invalid destination path). The queue
 * marks it failed on the first attempt.
 */
export class NonRetryableUploadError extends ExportError {
  constructor(
    code: Extract<
      ExportErrorCode,
      | 'missing_credentials'
      | 'invalid_path'
      | 'host_key_unpinned'
      | 'host_key_mismatch'
      | 'remote_exists'
      | 'unsupported_destination'
    >,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = 'NonRetryableUploadError';
  }
}

/** True when a failure must not be retried automatically. */
export function isNonRetryableUploadError(error: unknown): boolean {
  return (
    error instanceof NonRetryableUploadError ||
    (error instanceof ExportError &&
      (error.code === 'missing_credentials' ||
        error.code === 'invalid_path' ||
        error.code === 'unsupported_destination'))
  );
}

/** Thrown inside the queue when a running upload is cancelled. */
export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelledError';
  }
}

/** True for errors caused by cancelling an in-flight transfer. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof UploadCancelledError) return true;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true;
    return /\babort(ed)?\b/i.test(error.message);
  }
  return false;
}
