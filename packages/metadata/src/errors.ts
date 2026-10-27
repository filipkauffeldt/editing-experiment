/** Error raised by the metadata package with a stable, machine-readable code. */
export type MetadataErrorCode =
  | 'EXIFTOOL'
  | 'UNSUPPORTED_TARGET'
  | 'FILE_NOT_FOUND'
  | 'SIDECAR_MISSING'
  | 'INVALID_XMP'
  | 'INVALID_TEMPLATE'
  | 'INVALID_CODE_REPLACEMENTS';

export class MetadataError extends Error {
  readonly code: MetadataErrorCode;

  constructor(code: MetadataErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MetadataError';
    this.code = code;
  }
}
