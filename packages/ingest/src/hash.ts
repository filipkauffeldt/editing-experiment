import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { throwIfAborted } from './errors';

/** Streaming SHA-256 of a local file. */
export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, signal ? { signal } : undefined);
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk as Buffer);
    }
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}
