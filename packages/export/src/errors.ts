export type ExportErrorCode =
  | 'invalid_image'
  | 'invalid_preset'
  | 'invalid_file_name'
  | 'invalid_path'
  | 'embedded_preview'
  | 'missing_credentials'
  | 'unsupported_destination'
  | 'upload_not_found'
  | 'upload_invalid_state'
  | 'upload_cancelled';

/** Base class for errors raised by this package. Messages never contain secrets. */
export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExportError';
    this.code = code;
  }
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
