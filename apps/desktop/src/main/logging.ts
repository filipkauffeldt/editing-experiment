import type { WebContents } from 'electron';
import { join } from 'node:path';
import { bridgeConsole, logProcessErrors } from '../shared/log-bridge';
import { DEFAULT_LOG_LIMITS, RotatingLogFile, type LogLevel, type LogSource } from './log-file';

export interface AppLog {
  readonly file: RotatingLogFile;
  write(source: LogSource, level: LogLevel, message: string): void;
  /** Secret values that must never be written, wherever they turn up in a message. */
  addSecrets(values: Iterable<string | undefined>): void;
}

/** The folder the log files live in. */
export const logDirectory = (userDataDir: string): string => join(userDataDir, 'logs');

/**
 * Opens the log and routes main's own `console.warn`/`console.error`, uncaught exceptions and
 * unhandled rejections into it. Call it as early as possible so start-up problems are kept.
 * A listener on `uncaughtException` replaces Electron's error dialog, so the process carries on.
 */
export function startLogging(userDataDir: string): AppLog {
  const file = new RotatingLogFile({ dir: logDirectory(userDataDir), ...DEFAULT_LOG_LIMITS });
  const log: AppLog = {
    file,
    write: (source, level, message) => file.write(source, level, message),
    addSecrets: (values) => file.redactor.addSecrets(values),
  };
  const sink = (level: LogLevel, message: string): void => log.write('main', level, message);
  bridgeConsole(console, sink);
  logProcessErrors(process, sink);
  return log;
}

/**
 * Keeps the failures the jobs process reports to the renderer (`job.error`: a failed ingest, a
 * failed upload) in the log as well. They are the errors that matter on a day-to-day basis and are
 * not console output.
 */
export function logJobEvent(log: AppLog, channel: string, payload: unknown): void {
  if (channel !== 'jobs:event') return;
  const event = payload as { type?: string; scope?: string; message?: string };
  if (event.type !== 'job.error') return;
  log.write('jobs', 'error', `${event.scope ?? 'job'}: ${event.message ?? ''}`);
}

/** Keeps the renderer's warnings, errors (uncaught ones are console errors) and crashes. */
export function logRenderer(contents: WebContents, log: AppLog): void {
  contents.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return;
    const where = event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : '';
    log.write('renderer', event.level === 'error' ? 'error' : 'warn', `${event.message}${where}`);
  });
  contents.on('render-process-gone', (_event, details) => {
    log.write(
      'renderer',
      'error',
      `The renderer process is gone: ${details.reason} (exit code ${details.exitCode})`,
    );
  });
  contents.on('did-fail-load', (_event, code, description, url) => {
    log.write('renderer', 'error', `The renderer failed to load ${url}: ${description} (${code})`);
  });
}
