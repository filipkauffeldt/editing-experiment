import type { EventChannel, IpcHandlers } from '@ee/contracts';
import { photosHandlers } from './photos';
import { systemHandlers } from './system';

/** What a handler module gets from the jobs process. */
export interface JobsContext {
  mock: boolean;
  appVersion: string;
  /** Push an event to every renderer window. */
  emit<E extends EventChannel>(channel: E, payload: unknown): void;
}

/**
 * Handlers served by the jobs process. One module per namespace; a channel with
 * no entry rejects with `not_implemented`. Workstreams add their namespace's
 * module here (or replace the stub) instead of touching the dispatch code.
 */
export function createJobsHandlers(context: JobsContext): Partial<IpcHandlers> {
  return {
    ...systemHandlers(context),
    ...photosHandlers(context),
  };
}
