import type { EventChannel, InvokeChannel, IpcResult } from '@ee/contracts';

/** Messages main → jobs utility process. */
export interface JobsInvokeMessage {
  kind: 'invoke';
  /** Correlates the reply; unique per main process. */
  id: number;
  channel: InvokeChannel;
  args: unknown[];
}

/** Main asks the jobs process to answer an `app://` request. */
export interface JobsAppRequestMessage {
  kind: 'app-request';
  /** Shares the id space of {@link JobsInvokeMessage}. */
  id: number;
  url: string;
}

/**
 * Main hands the jobs process one end of the private secrets channel; the port
 * itself travels in the transfer list. See `secret-port.ts`.
 */
export interface JobsSecretPortMessage {
  kind: 'secret-port';
}

/** Flush and close services (ExifTool, upload queue, databases), then exit. */
export interface JobsShutdownMessage {
  kind: 'shutdown';
}

/** Main's answer to a {@link JobsTrashRequestMessage}; `error` is set when the file stayed. */
export interface JobsTrashResultMessage {
  kind: 'trash-result';
  id: number;
  error?: string;
}

export type JobsIncomingMessage =
  | JobsInvokeMessage
  | JobsAppRequestMessage
  | JobsSecretPortMessage
  | JobsShutdownMessage
  | JobsTrashResultMessage;

/** Reply to a {@link JobsInvokeMessage}. Failures travel as data (see `IpcResult`). */
export interface JobsResultMessage {
  kind: 'result';
  id: number;
  result: IpcResult<unknown>;
}

/**
 * What the jobs process answers for an `app://` request. Bodies are either a
 * small inline value or a file in the cache directory that main streams, so
 * large images never pass through the main process's JS heap.
 */
export interface AppBackendResponse {
  status: number;
  headers: Record<string, string>;
  /** Inline body (error messages). */
  body?: string;
  /** Absolute path under the cache directory to stream as the body. */
  file?: string;
}

/** Reply to a {@link JobsAppRequestMessage}. */
export interface JobsAppResultMessage {
  kind: 'app-result';
  id: number;
  response: AppBackendResponse;
}

/** Push event jobs → main, forwarded to every renderer window. */
export interface JobsEventMessage {
  kind: 'event';
  channel: EventChannel;
  payload: unknown;
}

/**
 * The jobs process asks main to move one file to the system trash. Electron's `shell` is not
 * available in a utility process. Only the photo deleter sends this, with a path it took from
 * its own index: the renderer never supplies one.
 */
export interface JobsTrashRequestMessage {
  kind: 'trash-request';
  id: number;
  path: string;
}

/** Messages jobs → main. */
export type JobsOutgoingMessage =
  JobsResultMessage | JobsAppResultMessage | JobsEventMessage | JobsTrashRequestMessage;
