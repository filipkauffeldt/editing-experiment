import {
  asDestinationId,
  asPresetId,
  type DestinationId,
  type ExportPreset,
  type ExportResize,
  type FileNamingMode,
  type PhotoId,
  type PresetId,
} from '@ee/contracts';
import { useEffect, useRef, useState } from 'react';
import { activeExportPreset, exportPhotoIds } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { Modal } from './Modal';
import { TemplateField } from './TemplateField';
import styles from './ExportDialog.module.css';

const newPresetId = (): PresetId => asPresetId(`preset-${Date.now().toString(36)}`);

/** Long enough that typing a template does not read the sidecar for every key. */
const TARGET_PREVIEW_DEBOUNCE_MS = 200;

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

/** Key order is not a preset change: compare the values, not how the draft was patched. */
const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const presetSignature = (preset: ExportPreset): string => JSON.stringify(stableValue(preset));

type TargetPreview =
  { status: 'loading' } | { status: 'ready'; path: string } | { status: 'error'; message: string };

function useExportTargetPreview(
  photoId: PhotoId | undefined,
  preset: ExportPreset | undefined,
): TargetPreview {
  const store = useAppStore();
  const [preview, setPreview] = useState<TargetPreview>({ status: 'loading' });
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    if (!photoId || !preset) return;
    const timer = setTimeout(() => {
      void store.previewExportTarget(photoId, preset).then(
        (target) => {
          if (request === latest.current) setPreview({ status: 'ready', path: target.path });
        },
        (cause: unknown) => {
          if (request === latest.current) {
            setPreview({
              status: 'error',
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        },
      );
    }, TARGET_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [store, photoId, preset]);

  return preview;
}

function SavesTo({ preview }: { preview: TargetPreview }) {
  return (
    <div className={styles.formRow}>
      <span className={styles.rowLabel}>Saves to</span>
      <span
        className={`${styles.target} ${preview.status === 'error' ? styles.targetError : ''}`}
        data-testid="export-target"
        role={preview.status === 'error' ? 'status' : undefined}
      >
        {preview.status === 'ready'
          ? preview.path
          : preview.status === 'error'
            ? preview.message
            : '…'}
      </span>
    </div>
  );
}

function PresetEditor({
  draft,
  setDraft,
  preview,
}: {
  draft: ExportPreset;
  setDraft: (next: ExportPreset) => void;
  preview: TargetPreview;
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
      <div className={styles.formRow}>
        <span className={styles.rowLabel}>Preset name</span>
        <input
          className={styles.input}
          value={draft.name}
          aria-label="Preset name"
          data-testid="preset-name"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </div>
      <div className={styles.form}>
        <div className={styles.formRow}>
          <span className={styles.rowLabel}>Folder</span>
          <TemplateField
            className={styles.rowControl}
            compact
            label="Folder"
            context="exportFolder"
            value={draft.folderTemplate}
            testId="folder-template"
            onChange={(folderTemplate) => patch({ folderTemplate })}
          />
        </div>
        <div className={styles.formRow}>
          <span className={styles.rowLabel}>File names</span>
          <div className={styles.rowControl}>
            <select
              className={styles.input}
              value={draft.fileNaming}
              aria-label="File names"
              data-testid="export-file-naming"
              onChange={(event) => patch({ fileNaming: event.target.value as FileNamingMode })}
            >
              <option value="keep">Keep original file name</option>
              <option value="rename">Rename</option>
            </select>
            {draft.fileNaming === 'rename' && (
              <TemplateField
                className={styles.rowControl}
                compact
                label="File name template"
                context="export"
                value={draft.fileNameTemplate}
                testId="filename-template"
                onChange={(fileNameTemplate) => patch({ fileNameTemplate })}
              />
            )}
          </div>
        </div>
        <div className={styles.formRow}>
          <span className={styles.rowLabel}>If it exists</span>
          <select
            className={styles.input}
            value={draft.ifExists}
            aria-label="If it exists"
            onChange={(event) =>
              patch({ ifExists: event.target.value as ExportPreset['ifExists'] })
            }
          >
            <option value="suffix">Add a suffix</option>
            <option value="overwrite">Overwrite</option>
            <option value="skip">Skip</option>
          </select>
        </div>
        <SavesTo preview={preview} />
        <div className={styles.formRow}>
          <span className={styles.rowLabel}>Size</span>
          <div className={`${styles.rowControl} ${styles.inlineRow}`}>
            <select
              className={`${styles.input} ${styles.grow}`}
              value={resizeMode}
              aria-label="Size"
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
            <span className={styles.quality}>
              <span className={styles.unit}>JPEG</span>
              <input
                className={`${styles.input} ${styles.qualityInput}`}
                type="number"
                min={1}
                max={100}
                value={draft.quality}
                aria-label="JPEG quality (1–100)"
                onChange={(event) => patch({ quality: Number(event.target.value) })}
              />
            </span>
          </div>
        </div>
        <div className={styles.formRow}>
          <span className={styles.rowLabel}>Sharpen</span>
          <div className={`${styles.rowControl} ${styles.inlineRow}`}>
            <select
              className={`${styles.input} ${styles.grow}`}
              value={draft.outputSharpening.target}
              aria-label="Sharpen"
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
              className={`${styles.input} ${styles.grow}`}
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
        </div>
        <div className={styles.formRow}>
          <span className={styles.rowLabel}>Metadata</span>
          <div className={`${styles.rowControl} ${styles.inlineRow}`}>
            <select
              className={`${styles.input} ${styles.grow}`}
              value={draft.metadata}
              aria-label="Metadata"
              onChange={(event) =>
                patch({ metadata: event.target.value as ExportPreset['metadata'] })
              }
            >
              <option value="all">All (EXIF + IPTC)</option>
              <option value="iptc">IPTC only</option>
              <option value="copyright">Copyright only</option>
              <option value="none">None</option>
            </select>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={draft.stripGps}
                onChange={(event) => patch({ stripGps: event.target.checked })}
              />
              Remove GPS location
            </label>
          </div>
        </div>
        <div className={styles.formRow}>
          <span className={styles.rowLabel}>Version</span>
          <select
            className={styles.input}
            value={draft.version}
            aria-label="Version"
            onChange={(event) => {
              const version = event.target.value as ExportPreset['version'];
              // Sending must never deliver a mosaic-less retouched photo.
              patch(version === 'develop' ? { version, sendTo: [] } : { version });
            }}
          >
            <option value="top">Top retouch version</option>
            <option value="develop">Develop only (export only)</option>
          </select>
        </div>
        <div className={styles.formRow}>
          <span className={styles.rowLabel}>Send to</span>
          <div className={styles.rowControl}>
            <div className={styles.checkboxes}>
              {state.destinations.map((destination) => (
                <label key={destination.id} className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={draft.sendTo.includes(destination.id)}
                    disabled={draft.version === 'develop'}
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
              {draft.version === 'develop' && (
                <span className={styles.hint}>Develop-only presets can be exported, not sent.</span>
              )}
              {state.destinations.length === 0 && (
                <span className={styles.hint}>No destinations configured yet.</span>
              )}
            </div>
          </div>
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
  const preview = useExportTargetPreview(photoIds[0], draft);
  const isActive = selected !== undefined && state.settings?.activePresetId === selected.id;
  const dirty =
    draft !== undefined &&
    selected !== undefined &&
    presetSignature(draft) !== presetSignature(selected);

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
    if (
      preset.folderTemplate.trim() === '' ||
      (preset.fileNaming === 'rename' && preset.fileNameTemplate.trim() === '')
    ) {
      setError('A folder template is required; a file name template is required when renaming');
      return undefined;
    }
    if (!Number.isInteger(preset.quality) || preset.quality < 1 || preset.quality > 100) {
      setError('Quality must be between 1 and 100');
      return undefined;
    }
    if (preset.version === 'develop' && preset.sendTo.length > 0) {
      setError('A develop-only preset cannot have send targets');
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

  const setActive = async (): Promise<void> => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const saved = await save(draft);
      if (saved) await store.setActivePreset(saved.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Export ${photoIds.length} photo${photoIds.length === 1 ? '' : 's'}`}
      onClose={() => store.closeExportDialog()}
      width={860}
      testId="export-dialog"
      footer={
        <>
          <div className={styles.footerActions}>
            <button
              type="button"
              className={styles.button}
              disabled={busy || !draft || !dirty}
              onClick={() => {
                if (draft) void save(draft);
              }}
              data-testid="save-preset"
            >
              Save preset
              {dirty && (
                <span
                  className={styles.unsavedDot}
                  title="Unsaved changes"
                  data-testid="preset-unsaved"
                />
              )}
            </button>
            {selected && !isActive && (
              <button
                type="button"
                className={styles.button}
                disabled={busy || !draft}
                onClick={() => void setActive()}
                data-testid="set-active-preset"
              >
                Set as active
              </button>
            )}
            <button
              type="button"
              className={styles.textButton}
              disabled={busy || !selected || state.exportPresets.length <= 1}
              onClick={() => void remove()}
              data-testid="delete-preset"
            >
              Delete preset
            </button>
          </div>
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
          {draft && <PresetEditor draft={draft} setDraft={setDraft} preview={preview} />}
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </div>
    </Modal>
  );
}
