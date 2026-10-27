import { IpcError, toIpcResult, type InvokeChannel } from '@ee/contracts';
import type { JobsInvokeMessage, JobsOutgoingMessage } from '../shared/jobs-protocol';
import { createJobsHandlers } from './handlers';

/**
 * Entry of the "jobs" utility process: ingest, metadata, export encode and the
 * upload queue run here so the main process stays responsive. It serves the
 * channels routed to `jobs` (see `shared/routing.ts`) over `parentPort`.
 */
const parentPort = process.parentPort;
const send = (message: JobsOutgoingMessage): void => parentPort.postMessage(message);

const mock = process.env.EE_MOCK === '1';
const handlers = createJobsHandlers({
  mock,
  appVersion: process.env.EE_APP_VERSION ?? '0.0.0',
  // Mock mode plays ingest and upload progress so the UI can be exercised live.
  simulate: mock,
  emit: (channel, payload) => send({ kind: 'event', channel, payload }),
});

parentPort.on('message', ({ data }: { data: JobsInvokeMessage }) => {
  if (data.kind !== 'invoke') return;
  const handler = handlers[data.channel as InvokeChannel] as
    ((...args: unknown[]) => Promise<unknown>) | undefined;
  void toIpcResult(async () => {
    if (!handler) throw new IpcError('not_implemented', `${data.channel} is not implemented yet`);
    return handler(...data.args);
  }).then((result) => send({ kind: 'result', id: data.id, result }));
});
