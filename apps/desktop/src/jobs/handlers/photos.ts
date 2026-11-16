import { IpcError, type NamespaceHandlers } from '@ee/contracts';
import { dirname } from 'node:path';
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
  const folderCounts = (): { path: string; count: number }[] => {
    const counts = new Map<string, number>();
    for (const photo of world.photos) {
      const folder = dirname(photo.path);
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    return [...counts].map(([path, count]) => ({ path, count }));
  };
  return {
    'photos:list': async (args) =>
      world.photos.filter(
        (photo) =>
          (!args?.sourceId || photo.sourceId === args.sourceId) &&
          (args?.folder === undefined || dirname(photo.path) === args.folder),
      ),
    'photos:folders': async () => ({ total: world.photos.length, folders: folderCounts() }),
    'photos:query': async (args) => {
      const scoped = world.photos.filter(
        (photo) => args?.folder === undefined || dirname(photo.path) === args.folder,
      );
      const offset = args?.offset ?? 0;
      return {
        photos: scoped.slice(offset, offset + (args?.limit ?? 1000)),
        total: scoped.length,
        scopeTotal: scoped.length,
      };
    },
    'photos:get': async ({ photoId }) => {
      const photo = world.photos.find((candidate) => candidate.id === photoId);
      if (!photo) throw new IpcError('not_found', `no photo ${photoId}`);
      return photo;
    },
  };
}
