import { IpcError, type IpcErrorCode, type IpcHandlers } from '@ee/contracts';
import { ExportError } from '@ee/export';
import { PresetParseError } from '@ee/develop-gl';
import { MetadataError } from '@ee/metadata';

const METADATA_CODES: Record<string, IpcErrorCode> = {
  FILE_NOT_FOUND: 'not_found',
  SIDECAR_MISSING: 'not_found',
  INVALID_XMP: 'invalid_argument',
  INVALID_TEMPLATE: 'invalid_argument',
  INVALID_CODE_REPLACEMENTS: 'invalid_argument',
  UNSUPPORTED_TARGET: 'invalid_argument',
};

const EXPORT_CODES: Record<string, IpcErrorCode> = {
  upload_not_found: 'not_found',
  invalid_image: 'invalid_argument',
  invalid_preset: 'invalid_argument',
  invalid_file_name: 'invalid_argument',
  invalid_path: 'invalid_argument',
  upload_invalid_state: 'invalid_argument',
  missing_credentials: 'auth',
  host_key_unpinned: 'auth',
  host_key_mismatch: 'auth',
};

/** Map errors from the workstream packages to the wire's {@link IpcError} codes. */
export function toIpcError(error: unknown): unknown {
  if (error instanceof IpcError) return error;
  if (error instanceof MetadataError) {
    return new IpcError(METADATA_CODES[error.code] ?? 'io', error.message, { cause: error });
  }
  if (error instanceof ExportError) {
    return new IpcError(EXPORT_CODES[error.code] ?? 'io', error.message, { cause: error });
  }
  if (error instanceof PresetParseError) {
    return new IpcError('invalid_argument', error.message, { cause: error });
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new IpcError('not_found', (error as Error).message, { cause: error });
  }
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return new IpcError('io', (error as Error).message, { cause: error });
  }
  return error;
}

/** Wrap every handler so thrown package errors reach the renderer with a meaningful code. */
export function withIpcErrors<T extends Partial<IpcHandlers>>(handlers: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [channel, handler] of Object.entries(handlers)) {
    const run = handler as (...args: unknown[]) => Promise<unknown>;
    wrapped[channel] = async (...args: unknown[]) => {
      try {
        return await run(...args);
      } catch (error) {
        throw toIpcError(error);
      }
    };
  }
  return wrapped as T;
}
