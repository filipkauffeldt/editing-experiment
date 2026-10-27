import { access } from 'node:fs/promises';
import type { IngestConfig, SourceConfig } from '@ee/contracts';

export function ingestConfig(
  source: SourceConfig | SourceConfig[],
  destination: string,
): IngestConfig {
  return {
    sources: Array.isArray(source) ? source : [source],
    destination: { path: destination },
    renameTemplate: '{filenamebase}_{seq:2}',
    codeReplacementPaths: [],
  };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
