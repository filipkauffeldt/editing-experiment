export { encodeJpeg, type EncodedJpeg } from './jpeg/encode';
export {
  assertNoEmbeddedPreviews,
  EmbeddedPreviewError,
  findEmbeddedPreviews,
  inspectJpegPreviews,
  type PreviewFinding,
  type PreviewFindingKind,
} from './jpeg/previews';
export { exportPhoto, type ExportPhotoOptions, type ExportedPhoto } from './export';
export { ExportError, UploadCancelledError, type ExportErrorCode } from './errors';
export {
  createPathTemplateContext,
  defaultExpandPathTemplate,
  resolveExpandPathTemplate,
  type ExpandPathTemplate,
  type ExportHooks,
  type GetSecretHook,
  type PathTemplateContext,
  type WriteMetadataHook,
} from './hooks';
export {
  assertSafeFileName,
  normalizeRemotePath,
  resolveFolderDestinationPath,
  tempRemotePath,
} from './upload/paths';
export { redactSecrets, safeErrorMessage } from './upload/redact';
export { JobEventEmitter, type JobEventListener } from './upload/events';
export {
  createConnector,
  createFolderConnector,
  createFtpConnector,
  createSftpConnector,
  getDestinationSecret,
  testDestination,
} from './upload/connectors';
export {
  fingerprintFromSha256Hex,
  normalizeHostKeyFingerprint,
  sha256Fingerprint,
} from './upload/connectors/sftp';
export type {
  ConnectorFactory,
  DestinationConnector,
  DestinationTestResult,
  StoredUploadItem,
  UploadRequest,
} from './upload/types';
