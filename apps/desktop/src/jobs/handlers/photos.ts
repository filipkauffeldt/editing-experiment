import { IpcError, type NamespaceHandlers } from '@ee/contracts';
import { mockPhotos } from '../../shared/mock';
import type { JobsContext } from './index';

/**
 * The photo index. Real data comes from SQLite once ingest exists; until then
 * only mock mode (`EE_MOCK=1`) serves photos, through this same IPC surface.
 */
export function photosHandlers(context: JobsContext): Partial<NamespaceHandlers<'photos'>> {
  if (!context.mock) {
    return {
      'photos:list': async () => [],
    };
  }
  const photos = mockPhotos();
  return {
    'photos:list': async (args) =>
      photos.filter((photo) => !args?.sourceId || photo.sourceId === args.sourceId),
    'photos:get': async ({ photoId }) => {
      const photo = photos.find((candidate) => candidate.id === photoId);
      if (!photo) throw new IpcError('not_found', `no photo ${photoId}`);
      return photo;
    },
  };
}
