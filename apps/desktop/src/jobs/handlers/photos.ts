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
      const limit = args?.limit ?? 1000;
      const offset =
        args?.fromEnd === true ? Math.max(0, scoped.length - limit) : (args?.offset ?? 0);
      return {
        photos: scoped.slice(offset, offset + limit),
        total: scoped.length,
        scopeTotal: scoped.length,
        offset,
      };
    },
    'photos:facets': async (args) => {
      const scoped = world.photos.filter(
        (photo) => args?.folder === undefined || dirname(photo.path) === args.folder,
      );
      const tag = { all: scoped.length, tagged: 0, untagged: 0 };
      const status = { 'not-sent': 0, failed: 0, edited: 0, 'metadata-differs': 0 };
      const cameras = new Map<string, number>();
      for (const photo of scoped) {
        if (photo.tagged) tag.tagged += 1;
        else tag.untagged += 1;
        if (photo.status.upload !== 'done') status['not-sent'] += 1;
        if (photo.status.upload === 'failed') status.failed += 1;
        if (photo.status.edited) status.edited += 1;
        if (photo.status.metadataDiffersFromTemplate) status['metadata-differs'] += 1;
        const camera = photo.camera;
        const key = camera
          ? `${camera.model ?? camera.make ?? 'Unknown'}|${camera.serialNumber ?? ''}`
          : '';
        if (key) cameras.set(key, (cameras.get(key) ?? 0) + 1);
      }
      return {
        shown: scoped.length,
        scopeTotal: scoped.length,
        tag,
        status,
        cameras: [...cameras].map(([key, count]) => {
          const [model, serial] = key.split('|');
          return { key, label: serial ? `${model} · ${serial}` : (model ?? key), count };
        }),
      };
    },
    'photos:get': async ({ photoId }) => {
      const photo = world.photos.find((candidate) => candidate.id === photoId);
      if (!photo) throw new IpcError('not_found', `no photo ${photoId}`);
      return photo;
    },
  };
}
