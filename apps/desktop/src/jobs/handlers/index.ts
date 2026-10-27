import type { EventChannel, IpcHandlers } from '@ee/contracts';
import { createMockHandlers, createMockWorld } from '../mock-world';
import { photosHandlers } from './photos';
import { systemHandlers } from './system';

/** What a handler module gets from the jobs process. */
export interface JobsContext {
  mock: boolean;
  appVersion: string;
  /** Emit mock ingest/upload progress on a timer (off in tests). */
  simulate?: boolean;
  /** Push an event to every renderer window. */
  emit<E extends EventChannel>(channel: E, payload: unknown): void;
}

/**
 * Handlers served by the jobs process. One module per namespace; a channel with
 * no entry rejects with `not_implemented`. Workstreams add their namespace's
 * module here (or replace the stub) instead of touching the dispatch code.
 */
export function createJobsHandlers(context: JobsContext): Partial<IpcHandlers> {
  const world = context.mock
    ? createMockWorld((channel, payload) => context.emit(channel, payload), context.simulate ?? false)
    : undefined;
  return {
    ...systemHandlers(context),
    ...photosHandlers(context, world),
    ...(world ? createMockHandlers(world, context.emit) : {}),
  };
}
