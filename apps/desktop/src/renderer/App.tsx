import { useEffect, useState } from 'react';
import styles from './App.module.css';
import { BatchCaptionDialog } from './components/BatchCaptionDialog';
import { DevelopView } from './components/DevelopView';
import { IngestView } from './components/IngestView';
import { LibraryView } from './components/LibraryView';
import { ExportDialog } from './components/ExportDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { ee } from './ee';
import { renderEditedPreview } from './edited-preview-render';
import { useKeyboardShortcuts } from './keyboard';
import { createAppStore, type AppStore } from './store';
import { AppStoreProvider, useAppState, useAppStore } from './store-context';

function Shell() {
  const store = useAppStore();
  const state = useAppState();
  useKeyboardShortcuts(store);

  return (
    <div className={styles.app} data-store-ready={!state.loading} data-module={state.module}>
      <TopBar loadError={state.error} />
      <div className={styles.module}>
        {state.module === 'develop' && <DevelopView />}
        {state.module === 'library' && <LibraryView />}
        {state.module === 'ingest' && <IngestView />}
      </div>
      <Toasts />
      {state.shortcutsOpen && <ShortcutsOverlay />}
      {state.batchCaptionOpen && <BatchCaptionDialog />}
      {state.dialog && <SettingsDialog />}
      {state.exportOpen && <ExportDialog />}
      {state.exportOpen && <ExportDialog />}
    </div>
  );
}

export function App({ store: provided }: { store?: AppStore } = {}) {
  const [store] = useState(() => provided ?? createAppStore(ee, { renderEditedPreview }));

  useEffect(() => {
    void store.init();
    return () => {
      void store.dispose();
    };
  }, [store]);

  return (
    <AppStoreProvider store={store}>
      <Shell />
    </AppStoreProvider>
  );
}
