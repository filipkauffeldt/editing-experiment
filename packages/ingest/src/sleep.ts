import { IngestAbortError, throwIfAborted } from './errors';

/**
 * Waits for `milliseconds`, but wakes at once when `signal` aborts, so Stop
 * never waits for a whole poll interval.
 */
export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new IngestAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
