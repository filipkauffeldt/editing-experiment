import { appendFileSync } from 'node:fs';

/** Debug breadcrumbs for native crashes: written synchronously so the last line survives a segfault. */
export function trace(step: string): void {
  const file = process.env.EE_JOBS_TRACE;
  if (file) appendFileSync(file, `${Date.now()} ${step}\n`);
}
