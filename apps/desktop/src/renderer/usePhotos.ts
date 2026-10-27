import type { Photo } from '@ee/contracts';
import { useEffect, useState } from 'react';
import { ee } from './ee';

/** The photo index as the backend reports it, kept live by `photos:added` / `photos:updated`. */
export function usePhotos(): { photos: Photo[]; error: string | undefined } {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const stopAdded = ee.on('photos:added', (photo) =>
      setPhotos((current) => [...current.filter((p) => p.id !== photo.id), photo]),
    );
    const stopUpdated = ee.on('photos:updated', (photo) =>
      setPhotos((current) => current.map((p) => (p.id === photo.id ? photo : p))),
    );
    ee.invoke('photos:list')
      .then(setPhotos)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      stopAdded();
      stopUpdated();
    };
  }, []);

  return { photos, error };
}
