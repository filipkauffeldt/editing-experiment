import { ee } from '../ee';
import { useAppState, useAppStore } from '../store-context';
import { PlusIcon } from './icons';
import styles from './SettingsDialog.module.css';

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Global Photo Mechanic templates and code replacement files, shared by ingest and the panel. */
export function MetadataSettings() {
  const store = useAppStore();
  const state = useAppState();
  const templates = state.settings?.metadataTemplates ?? [];
  const codeReplacementPaths = state.settings?.codeReplacementPaths ?? [];

  return (
    <div className={styles.formWide} data-testid="metadata-settings">
      <div className={styles.field}>
        <span className={styles.label}>Photo Mechanic templates (.XMP)</span>
        <p className={styles.hint}>
          Templates the Metadata panel and ingest can apply. The app keeps their paths; it never
          copies the files.
        </p>
        <div className={styles.fileList} data-testid="metadata-templates-list">
          {templates.length === 0 && <span className={styles.hint}>No templates yet.</span>}
          {templates.map((path) => (
            <div key={path} className={styles.fileRow}>
              <span className={styles.fileName}>{baseName(path)}</span>
              <span className={styles.filePath}>{path}</span>
              <button
                type="button"
                className={styles.removeFile}
                aria-label={`Remove ${baseName(path)}`}
                onClick={() => void store.removeMetadataTemplate(path)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.addButton}
            onClick={async () => {
              const paths = await ee.invoke('dialog:pick', {
                kind: 'file',
                title: 'Metadata template',
                extensions: ['xmp'],
                multiple: true,
              });
              await store.addMetadataTemplates(paths);
            }}
          >
            <PlusIcon size={9} /> Add template…
          </button>
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Code replacement files</span>
        <p className={styles.hint}>
          Tab-delimited files, later files override earlier ones. Active in ingest, the
          caption/metadata fields and batch caption.
        </p>
        <div className={styles.fileList} data-testid="code-replacement-list">
          {codeReplacementPaths.length === 0 && (
            <span className={styles.hint}>No code replacement files.</span>
          )}
          {codeReplacementPaths.map((path) => (
            <div key={path} className={styles.fileRow}>
              <span className={styles.fileName}>{baseName(path)}</span>
              <span className={styles.filePath}>{path}</span>
              <button
                type="button"
                className={styles.removeFile}
                aria-label={`Remove ${baseName(path)}`}
                onClick={() => void store.removeCodeReplacementFile(path)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.addButton}
            onClick={async () => {
              const paths = await ee.invoke('dialog:pick', {
                kind: 'file',
                title: 'Code replacement file',
                extensions: ['txt'],
                multiple: true,
              });
              await store.addCodeReplacementFiles(paths);
            }}
          >
            <PlusIcon size={9} /> Add code replacement file
          </button>
        </div>
      </div>
    </div>
  );
}
