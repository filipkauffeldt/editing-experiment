import { format } from 'node:util';

/** Where a process sends the warnings and errors it wants kept. */
export type LogSink = (level: 'warn' | 'error', message: string) => void;

/**
 * Passes `console.warn` and `console.error` on to `sink` as well as to the console they were
 * written for. `console.log`, `info` and `debug` stay on the console only: the file is for
 * problems.
 */
export function bridgeConsole(target: Pick<Console, 'warn' | 'error'>, sink: LogSink): void {
  for (const level of ['warn', 'error'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]): void => {
      original(...args);
      try {
        sink(level, format(...args));
      } catch {
        // Logging must never throw into the code that logged.
      }
    };
  }
}

/** The text to log for something that was thrown or rejected: a stack when there is one. */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return format(value);
}

/**
 * Logs uncaught exceptions and unhandled rejections of this process. A listener on
 * `uncaughtException` keeps the process alive, so `afterUncaught` decides what happens next.
 */
export function logProcessErrors(
  proc: Pick<NodeJS.Process, 'on'>,
  sink: LogSink,
  afterUncaught: () => void = () => {},
): void {
  proc.on('uncaughtException', (error, origin) => {
    sink('error', `Uncaught exception (${origin}): ${describeThrown(error)}`);
    afterUncaught();
  });
  proc.on('unhandledRejection', (reason) => {
    sink('error', `Unhandled rejection: ${describeThrown(reason)}`);
  });
}
