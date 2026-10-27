import { useEffect, useMemo, useState } from 'react';
import styles from './App.module.css';
import { BottomBar } from './components/BottomBar';
import { DevelopPanel } from './components/DevelopPanel';
import { MetadataPanel } from './components/MetadataPanel';
import { PhotoView } from './components/PhotoView';
import { SettingsDialog } from './components/SettingsDialog';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { StatusBar } from './components/StatusBar';
import { Toasts } from './components/Toasts';
import { ee } from './ee';
import { useKeyboardShortcuts } from './keyboard';
import { activePhoto, createAppStore, selectVisiblePhotos, type AppStore } from './store';
import { AppStoreProvider, useAppState, useAppStore } from './store-context';

function Shell() {
  const store = useAppStore();
  const state = useAppState();
  useKeyboardShortcuts(store);

  const photos = useMemo(
    () => selectVisiblePhotos(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only these slices affect the result
    [state.photos, state.flags, state.filter, state.sort],
  );
  const selected = activePhoto(state);

  return (
    <div className={styles.app}>
      <StatusBar className={styles.status} photoCount={photos.length} loadError={state.error} />
      <MetadataPanel className={styles.meta} />
      <PhotoView className={styles.photo} photo={selected} />
      <DevelopPanel className={styles.develop} />
      <BottomBar className={styles.bottom} photos={photos} />
      <Toasts />
      {state.shortcutsOpen && <ShortcutsOverlay />}
      {state.dialog && <SettingsDialog />}
    </div>
  );
}

export function App({ store: provided }: { store?: AppStore } = {}) {
  const [store] = useState(() => provided ?? createAppStore(ee));

  useEffect(() => {
    void store.init();
    return () => store.dispose();
  }, [store]);

  return (
    <AppStoreProvider store={store}>
      <Shell />
    </AppStoreProvider>
  );
}
