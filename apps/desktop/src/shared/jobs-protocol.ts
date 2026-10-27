import type { EventChannel, InvokeChannel, IpcResult } from '@ee/contracts';

/** Messages main → jobs utility process. */
export interface JobsInvokeMessage {
  kind: 'invoke';
  /** Correlates the reply; unique per main process. */
  id: number;
  channel: InvokeChannel;
  args: unknown[];
}

/** Reply to a {@link JobsInvokeMessage}. Failures travel as data (see `IpcResult`). */
export interface JobsResultMessage {
  kind: 'result';
  id: number;
  result: IpcResult<unknown>;
}

/** Push event jobs → main, forwarded to every renderer window. */
export interface JobsEventMessage {
  kind: 'event';
  channel: EventChannel;
  payload: unknown;
}

/** Messages jobs → main. */
export type JobsOutgoingMessage = JobsResultMessage | JobsEventMessage;
