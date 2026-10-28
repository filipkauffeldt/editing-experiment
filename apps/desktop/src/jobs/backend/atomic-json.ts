import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write JSON so a crash leaves either the old or the new file, never half of one. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? {} : { mode });
  renameSync(temp, file);
}
