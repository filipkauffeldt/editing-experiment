import type { JobEvent } from '@ee/contracts';

export type JobEventListener = (event: JobEvent) => void;

/** Small synchronous event hub for the jobs process to forward to IPC. */
export class JobEventEmitter {
  private readonly listeners = new Set<JobEventListener>();

  on(listener: JobEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  off(listener: JobEventListener): void {
    this.listeners.delete(listener);
  }

  emit(event: JobEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
