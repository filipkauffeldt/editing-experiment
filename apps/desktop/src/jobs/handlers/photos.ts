import { IpcError, type NamespaceHandlers } from '@ee/contracts';
import type { MockWorld } from '../mock-world';
import type { JobsContext } from './index';

/**
 * The photo index. Real data comes from SQLite once ingest exists; until then
 * only mock mode (`EE_MOCK=1`) serves photos, through this same IPC surface.
 */
export function photosHandlers(
  context: JobsContext,
  world: MockWorld | undefined,
): Partial<NamespaceHandlers<'photos'>> {
  if (!context.mock || !world) {
    return {
      'photos:list': async () => [],
    };
  }
  return {
    'photos:list': async (args) =>
      world.photos.filter((photo) => !args?.sourceId || photo.sourceId === args.sourceId),
    'photos:get': async ({ photoId }) => {
      const photo = world.photos.find((candidate) => candidate.id === photoId);
      if (!photo) throw new IpcError('not_found', `no photo ${photoId}`);
      return photo;
    },
  };
}
