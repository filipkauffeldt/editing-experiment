import { useState } from 'react';
import styles from './App.module.css';
import { BottomBar } from './components/BottomBar';
import { DevelopPanel } from './components/DevelopPanel';
import { MetadataPanel } from './components/MetadataPanel';
import { PhotoView } from './components/PhotoView';
import { StatusBar } from './components/StatusBar';
import { usePhotos } from './usePhotos';

export function App() {
  const { photos, error } = usePhotos();
  const [selectedId, setSelectedId] = useState<string>();
  const selected = photos.find((photo) => photo.id === selectedId) ?? photos[0];

  // Advancing is the renderer's job; the export call joins this in the export workstream.
  const finishAndNext = (): void => {
    const index = photos.findIndex((photo) => photo.id === selected?.id);
    const next = photos[index + 1];
    if (next) setSelectedId(next.id);
  };

  return (
    <div className={styles.app}>
      <StatusBar className={styles.status} photoCount={photos.length} loadError={error} />
      <MetadataPanel className={styles.meta} photo={selected} />
      <PhotoView className={styles.photo} photo={selected} />
      <DevelopPanel className={styles.develop} />
      <BottomBar
        className={styles.bottom}
        photos={photos}
        selectedId={selected?.id}
        onSelect={setSelectedId}
        onFinish={finishAndNext}
      />
    </div>
  );
}
