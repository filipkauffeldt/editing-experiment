import type {
  ConnectionTestResult,
  CredentialSecret,
  Destination,
  UploadId,
  UploadItem,
} from '@ee/contracts';

/** Result of probing a destination. SFTP TOFU fills in the fingerprint. */
export interface DestinationTestResult extends ConnectionTestResult {
  /** `SHA256:...` host key fingerprint learned on first connect. */
  hostKeyFingerprint?: string;
}

/** Everything a destination connector needs for one transfer. */
export interface UploadRequest {
  destination: Destination;
  uploadId: UploadId;
  /** Unique per run; also used to make the `.part` name collision-free. */
  claimToken: string;
  localPath: string;
  /** Expanded path on the destination, file name included. */
  remotePath: string;
  bytesTotal: number;
  secret: CredentialSecret;
  signal: AbortSignal;
  /** Reports bytes written so far; safe to call often. */
  report(bytesSent: number): void;
}

/** Transfers one file to one destination. Must leave no partial file at `remotePath`. */
export interface DestinationConnector {
  upload(request: UploadRequest): Promise<void>;
  test(secret: CredentialSecret): Promise<DestinationTestResult>;
}

/** Builds a connector for a destination. Injectable for tests and future kinds. */
export type ConnectorFactory = (destination: Destination) => DestinationConnector;

/** Queue row plus the parts that are not part of the public {@link UploadItem}. */
export interface StoredUploadItem extends UploadItem {
  destination: Destination;
  /** Epoch ms before which a retry must not be attempted. */
  nextAttemptAt: number;
  /** Identifies the current run, so a cancelled run cannot touch its successor. */
  claimToken?: string;
}
