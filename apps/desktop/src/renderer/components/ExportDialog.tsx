import {
  asDestinationId,
  asPresetId,
  type DestinationId,
  type ExportPreset,
  type ExportResize,
  type PresetId,
} from '@ee/contracts';
import { useEffect, useState } from 'react';
import { activeExportPreset, exportPhotoIds } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { Modal } from './Modal';
import styles from './ExportDialog.module.css';

const newPresetId = (): PresetId => asPresetId(`preset-${Date.now().toString(36)}`);

const resizeAmount = (resize: ExportResize): string => {
  if (resize.mode === 'longEdge' || resize.mode === 'shortEdge') return String(resize.pixels);
  if (resize.mode === 'megapixels') return String(resize.megapixels);
  return '';
};

const defaultDraft = (source: ExportPreset): ExportPreset => ({
  ...source,
  resize: { ...source.resize },
  outputSharpening: { ...source.outputSharpening },
  sendTo: [...source.sendTo],
});

function PresetEditor({
  draft,
  setDraft,
}: {
  draft: ExportPreset;
  setDraft: (next: ExportPreset) => void;
}) {
  const state = useAppState();
  const patch = (change: Partial<ExportPreset>): void => setDraft({ ...draft, ...change });
  const resizeValue = resizeAmount(draft.resize);
  const resizeMode = draft.resize.mode;

  const setResizeMode = (mode: ExportResize['mode']): void => {
    if (mode === 'none') patch({ resize: { mode: 'none' } });
    else if (mode === 'megapixels')
      patch({ resize: { mode, megapixels: Number(resizeValue) || 12 } });
    else patch({ resize: { mode, pixels: Number(resizeValue) || 2400 } });
  };

  return (
    <div className={styles.editor}>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.label}>Preset name</span>
          <input
            className={styles.input}
            value={draft.name}
            data-testid="preset-name"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>JPEG quality (1–100)</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            max={100}
            value={draft.quality}
            onChange={(event) => patch({ quality: Number(event.target.value) })}
          />
        </label>

        <label className={`${styles.field} ${styles.wide}`}>
          <span className={styles.label}>Folder template (relative to the export root)</span>
          <input
            className={styles.input}
            value={draft.folderTemplate}
            data-testid="folder-template"
            onChange={(event) => patch({ folderTemplate: event.target.value })}
          />
        </label>
        <label className={`${styles.field} ${styles.wide}`}>
          <span className={styles.label}>File name template</span>
          <input
            className={styles.input}
            value={draft.fileNameTemplate}
            data-testid="filename-template"
            onChange={(event) => patch({ fileNameTemplate: event.target.value })}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>If the file exists</span>
          <select
            className={styles.input}
            value={draft.ifExists}
            onChange={(event) =>
              patch({ ifExists: event.target.value as ExportPreset['ifExists'] })
            }
          >
            <option value="suffix">Add a suffix</option>
            <option value="overwrite">Overwrite</option>
            <option value="skip">Skip</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Resize</span>
          <div className={styles.row}>
            <select
              className={styles.input}
              value={resizeMode}
              onChange={(event) => setResizeMode(event.target.value as ExportResize['mode'])}
            >
              <option value="none">Full size</option>
              <option value="longEdge">Long edge</option>
              <option value="shortEdge">Short edge</option>
              <option value="megapixels">Megapixels</option>
            </select>
            {resizeMode !== 'none' && (
              <input
                className={`${styles.input} ${styles.short}`}
                type="number"
                min={1}
                step={resizeMode === 'megapixels' ? 0.1 : 1}
                value={resizeValue}
                aria-label="Resize amount"
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (resizeMode === 'megapixels')
                    patch({ resize: { mode: resizeMode, megapixels: value } });
                  else patch({ resize: { mode: resizeMode, pixels: value } });
                }}
              />
            )}
          </div>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Output sharpening</span>
          <div className={styles.row}>
            <select
              className={styles.input}
              value={draft.outputSharpening.target}
              onChange={(event) =>
                patch({
                  outputSharpening: {
                    ...draft.outputSharpening,
                    target: event.target.value as ExportPreset['outputSharpening']['target'],
                  },
                })
              }
            >
              <option value="none">None</option>
              <option value="screen">Screen</option>
              <option value="matte">Matte paper</option>
              <option value="glossy">Glossy paper</option>
            </select>
            <select
              className={styles.input}
              value={draft.outputSharpening.amount}
              aria-label="Sharpening amount"
              disabled={draft.outputSharpening.target === 'none'}
              onChange={(event) =>
                patch({
                  outputSharpening: {
                    ...draft.outputSharpening,
                    amount: event.target.value as ExportPreset['outputSharpening']['amount'],
                  },
                })
              }
            >
              <option value="low">Low</option>
              <option value="standard">Standard</option>
              <option value="high">High</option>
            </select>
          </div>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Metadata</span>
          <select
            className={styles.input}
            value={draft.metadata}
            onChange={(event) =>
              patch({ metadata: event.target.value as ExportPreset['metadata'] })
            }
          >
            <option value="all">All (EXIF + IPTC)</option>
            <option value="iptc">IPTC only</option>
            <option value="copyright">Copyright only</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Edit version</span>
          <select
            className={styles.input}
            value={draft.version}
            onChange={(event) => patch({ version: event.target.value as ExportPreset['version'] })}
          >
            <option value="top">Top retouch version</option>
            <option value="develop">Develop only</option>
          </select>
        </label>

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={draft.stripGps}
            onChange={(event) => patch({ stripGps: event.target.checked })}
          />
          Remove GPS location
        </label>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Send to</span>
        <div className={styles.checkboxes}>
          {state.destinations.map((destination) => (
            <label key={destination.id} className={styles.checkbox}>
              <input
                type="checkbox"
                checked={draft.sendTo.includes(destination.id)}
                onChange={(event) => {
                  const id = asDestinationId(destination.id);
                  const sendTo = event.target.checked
                    ? [...draft.sendTo, id]
                    : draft.sendTo.filter((candidate: DestinationId) => candidate !== id);
                  patch({ sendTo });
                }}
              />
              {destination.name}
              <span className={styles.kind}>{destination.kind.toUpperCase()}</span>
            </label>
          ))}
          {state.destinations.length === 0 && (
            <span className={styles.hint}>No destinations configured yet.</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Export preset list and editor; the two buttons start a background batch. */
export function ExportDialog() {
  const store = useAppStore();
  const state = useAppState();
  const photoIds = exportPhotoIds(state);
  const initial = activeExportPreset(state);
  const [selectedId, setSelectedId] = useState<PresetId | undefined>(
    initial?.id ?? state.exportPresets[0]?.id,
  );
  const selected =
    state.exportPresets.find((preset) => preset.id === selectedId) ?? state.exportPresets[0];
  const [draft, setDraft] = useState<ExportPreset | undefined>(
    selected ? defaultDraft(selected) : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // A removed preset or a save that reorders the list: keep the editor valid.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!selected) return;
    setDraft(defaultDraft(selected));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selected]);

  const save = async (preset: ExportPreset): Promise<ExportPreset | undefined> => {
    if (preset.name.trim() === '') {
      setError('A preset needs a name');
      return undefined;
    }
    if (preset.folderTemplate.trim() === '' || preset.fileNameTemplate.trim() === '') {
      setError('Folder and file name templates are required');
      return undefined;
    }
    if (!Number.isInteger(preset.quality) || preset.quality < 1 || preset.quality > 100) {
      setError('Quality must be between 1 and 100');
      return undefined;
    }
    setError(undefined);
    await store.saveExportPreset(preset);
    return preset;
  };

  const start = async (send: boolean): Promise<void> => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const saved = await save(draft);
      if (!saved) return;
      if (state.settings?.activePresetId === undefined) await store.setActivePreset(saved.id);
      store.closeExportDialog();
      await store.exportSelected(send, saved.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const addPreset = async (): Promise<void> => {
    const source = draft ?? selected;
    if (!source) return;
    const preset: ExportPreset = {
      ...defaultDraft(source),
      id: newPresetId(),
      name: 'New preset',
    };
    setSelectedId(preset.id);
    setDraft(preset);
    await save(preset);
  };

  const remove = async (): Promise<void> => {
    if (!selected || state.exportPresets.length <= 1 || busy) return;
    setBusy(true);
    try {
      await store.removeExportPreset(selected.id);
      const next = state.exportPresets.find((preset) => preset.id !== selected.id);
      setSelectedId(next?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export"
      subtitle={`${photoIds.length} photo${photoIds.length === 1 ? '' : 's'} selected`}
      onClose={() => store.closeExportDialog()}
      width={860}
      testId="export-dialog"
      footer={
        <>
          <span className={styles.hint}>
            Export writes to the local folder first; Export &amp; send uploads those files.
          </span>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.button}
            disabled={busy || !draft}
            onClick={() => void start(false)}
            data-testid="export-only"
          >
            Export only
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={busy || !draft}
            onClick={() => void start(true)}
            data-testid="export-send"
          >
            Export &amp; send
          </button>
        </>
      }
    >
      <div className={styles.split}>
        <div className={styles.listPane}>
          <div className={styles.list} role="listbox" aria-label="Export presets">
            {state.exportPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="option"
                aria-selected={preset.id === selected?.id}
                className={`${styles.listItem} ${
                  preset.id === selected?.id ? styles.listActive : ''
                }`}
                onClick={() => {
                  setSelectedId(preset.id);
                  setDraft(defaultDraft(preset));
                }}
              >
                <span className={styles.listName}>{preset.name}</span>
                {state.settings?.activePresetId === preset.id && (
                  <span className={styles.activeBadge}>active</span>
                )}
              </button>
            ))}
          </div>
          <button type="button" className={styles.addButton} onClick={() => void addPreset()}>
            + New preset
          </button>
        </div>

        <div className={styles.editorPane}>
          {draft && <PresetEditor draft={draft} setDraft={setDraft} />}
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              disabled={busy || !selected}
              onClick={() => void remove()}
            >
              Remove
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy || !draft}
              onClick={() => {
                if (!draft) return;
                void save(draft).then((saved) => {
                  if (saved) void store.setActivePreset(saved.id);
                });
              }}
            >
              Set as active
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy || !draft}
              onClick={() => {
                if (draft) void save(draft);
              }}
            >
              Save preset
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
