import { readDriveInfo } from '@ee/core';
import { CardScanner } from '@ee/ingest';
import { delimiter } from 'node:path';

/**
 * `EE_CARD_ROOTS` replaces the folders that are scanned for cards (separated like `PATH`). It
 * exists so end-to-end tests can mount a card in a temp folder; the app never sets it.
 */
export function cardScannerFromEnv(env: NodeJS.ProcessEnv): CardScanner {
  const roots = env.EE_CARD_ROOTS?.split(delimiter).filter((root) => root !== '');
  // The volume label of a Windows drive comes from the native core; other platforms ignore it.
  return new CardScanner(roots && roots.length > 0 ? { mountRoots: roots } : { readDriveInfo });
}
