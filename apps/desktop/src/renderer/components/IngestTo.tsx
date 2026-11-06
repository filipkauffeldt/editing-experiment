import type { FileNamingMode, TemplateApplyMode } from '@ee/contracts';
import type { IngestPathPreview } from '@ee/ingest/destination-path';
import { useEffect, useId, useMemo, type ReactNode } from 'react';
import { ee } from '../ee';
import { EXAMPLE_FILE_NAME } from '../ingest-preview';
import { groupPresets } from '../preset-groups';
import { useAppState, useAppStore } from '../store-context';
import type { IngestSettingsController } from '../use-ingest-settings';
import { TemplateField } from './TemplateField';
import { Dot } from './ui/Dot';
import styles from './IngestTo.module.css';

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** A boxed control with a compact action inside it, like Browse next to a folder. */
function Boxed({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <span className={styles.box}>
      {children}
      {action}
    </span>
  );
}

function FolderField({
  label,
  value,
  placeholder,
  error,
  testId,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  error?: string | undefined;
  testId?: string;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <Boxed
        action={
          <button
            type="button"
            className={styles.action}
            aria-label={`Browse for ${label.toLowerCase()}`}
            onClick={async () => {
              const [path] = await ee.invoke('dialog:pick', { kind: 'folder' });
              if (path) onChange(path);
            }}
          >
            Browse
          </button>
        }
      >
        <input
          id={id}
          className={styles.input}
          value={value}
          placeholder={placeholder}
          data-testid={testId}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </Boxed>
      {error && <span className={styles.error}>{error}</span>}
    </>
  );
}

/** Where the first file lands, in the text ingest will use; the reason when it would refuse. */
function Preview({ preview, hidden }: { preview: IngestPathPreview; hidden: boolean }) {
  return (
    <div className={styles.preview} data-testid="ingest-preview">
      <span className={styles.previewLabel}>First file goes to</span>
      {hidden ? (
        <span className={styles.previewMuted}>—</span>
      ) : preview.ok ? (
        <>
          <span className={`${styles.previewPath} mono`} data-testid="ingest-preview-path">
            {preview.path}
          </span>
          <span className={styles.previewMuted}>
            Example name {EXAMPLE_FILE_NAME} and today&apos;s date; each photo uses its own.
          </span>
        </>
      ) : (
        <span className={styles.previewMuted} data-testid="ingest-preview-problem">
          {preview.message}
        </span>
      )}
    </div>
  );
}

/**
 * Where the photos go and what is done to them on the way in. Every change is saved by itself
 * (see `useIngestSettings`), so there is nothing to confirm.
 */
export function IngestTo({
  settings,
  preview,
  className,
}: {
  settings: IngestSettingsController;
  preview: IngestPathPreview;
  className?: string;
}) {
  const store = useAppStore();
  const state = useAppState();
  const { form, errors, saveError, set } = settings;
  const namingId = useId();
  const templateId = useId();
  const modeId = useId();
  const presetId = useId();
  const presetGroups = useMemo(() => groupPresets(state.presets), [state.presets]);
  const templateOptions = [
    ...new Set(
      [
        ...(state.settings?.metadataTemplates ?? []),
        state.settings?.ingest.metadataTemplatePath,
        form.metadataTemplatePath,
      ].filter((path): path is string => path !== undefined && path !== ''),
    ),
  ];

  // The list is read again when the view opens, so a preset made in Lightroom is there.
  useEffect(() => {
    void store.loadPresetIndex(true);
  }, [store]);

  return (
    <section className={`${styles.to} ${className ?? ''}`} data-testid="ingest-to">
      <h3 className={styles.title}>To</h3>
      <div className={styles.body}>
        <div className={styles.group}>
          <div className={styles.form}>
            <FolderField
              label="Folder"
              value={form.destination}
              error={errors.destination}
              testId="ingest-destination"
              onChange={(value) => set('destination', value)}
            />
            <span className={styles.label}>Subfolder</span>
            <TemplateField
              compact
              label="Subfolder"
              context="ingest"
              value={form.subfolder}
              placeholder="{date}/{sourceName}"
              testId="ingest-subfolder-template"
              onChange={(value) => set('subfolder', value)}
            />
            <label className={styles.label} htmlFor={namingId}>
              File names
            </label>
            <select
              id={namingId}
              className={styles.select}
              value={form.fileNaming}
              data-testid="ingest-file-naming"
              onChange={(event) => set('fileNaming', event.target.value as FileNamingMode)}
            >
              <option value="keep">Keep original names</option>
              <option value="rename">Rename</option>
            </select>
            {form.fileNaming === 'rename' && (
              <>
                <span className={styles.label}>Rename template</span>
                <TemplateField
                  compact
                  label="Rename template"
                  context="ingest"
                  value={form.renameTemplate}
                  testId="ingest-rename-template"
                  onChange={(value) => set('renameTemplate', value)}
                />
                {errors.renameTemplate && (
                  <span className={styles.error} role="alert">
                    {errors.renameTemplate}
                  </span>
                )}
              </>
            )}
            <FolderField
              label="Backup"
              value={form.backup}
              placeholder="None"
              testId="ingest-backup"
              onChange={(value) => set('backup', value)}
            />
          </div>

          <Preview
            preview={preview}
            hidden={Boolean(errors.destination || errors.renameTemplate)}
          />
        </div>

        <div className={styles.group}>
          <h4 className={styles.sub}>Apply on the way in</h4>
          <div className={styles.form}>
            <label className={styles.label} htmlFor={templateId}>
              Template
            </label>
            <span className={styles.pair}>
              <Boxed
                action={
                  <button
                    type="button"
                    className={styles.action}
                    aria-label="Import a metadata template"
                    onClick={async () => {
                      const [path] = await ee.invoke('dialog:pick', {
                        kind: 'file',
                        title: 'Metadata template',
                        extensions: ['xmp'],
                      });
                      if (path) {
                        await store.addMetadataTemplates([path]);
                        set('metadataTemplatePath', path);
                      }
                    }}
                  >
                    Import
                  </button>
                }
              >
                <select
                  id={templateId}
                  className={styles.input}
                  value={form.metadataTemplatePath}
                  onChange={(event) => set('metadataTemplatePath', event.target.value)}
                >
                  <option value="">None</option>
                  {templateOptions.map((path) => (
                    <option key={path} value={path}>
                      {baseName(path)}
                    </option>
                  ))}
                </select>
              </Boxed>
              {form.metadataTemplatePath !== '' && (
                <select
                  id={modeId}
                  className={`${styles.select} ${styles.mode}`}
                  aria-label="Template mode"
                  value={form.metadataTemplateMode}
                  onChange={(event) =>
                    set('metadataTemplateMode', event.target.value as TemplateApplyMode)
                  }
                >
                  <option value="replace">Replace existing values</option>
                  <option value="fillEmpty">Fill empty fields</option>
                </select>
              )}
            </span>
            <label className={styles.label} htmlFor={presetId}>
              Develop preset
            </label>
            <select
              id={presetId}
              className={styles.select}
              value={form.developPresetId}
              onChange={(event) => set('developPresetId', event.target.value)}
            >
              <option value="">None</option>
              {form.developPresetId !== '' &&
                !state.presets.some((p) => p.id === form.developPresetId) && (
                  <option value={form.developPresetId}>{form.developPresetId} (not found)</option>
                )}
              {presetGroups.map((group) =>
                group.name === '' ? (
                  group.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))
                ) : (
                  <optgroup key={group.name} label={group.name}>
                    {group.presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          </div>
        </div>

        {saveError && (
          <p className={styles.saveError} role="alert" data-testid="ingest-save-error">
            <Dot tone="error" /> Not saved: {saveError}
          </p>
        )}
      </div>
    </section>
  );
}
