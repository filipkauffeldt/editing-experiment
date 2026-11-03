import type { IptcFields, PhotoId } from '@ee/contracts';
import { useState } from 'react';
import { METADATA_SECTIONS, metadataValue, type MetadataFieldName } from '../metadata-fields';
import { activePhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { CloseIcon } from './icons';
import { Panel } from './Panel';
import { Button } from './ui/Button';
import { Select, TextArea, TextInput } from './ui/Field';
import { PanelSection } from './ui/PanelSection';
import styles from './MetadataPanel.module.css';

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

function differs(
  field: MetadataFieldName,
  fields: IptcFields,
  template: IptcFields | undefined,
): boolean {
  if (!template) return false;
  const templateValue = template[field];
  if (templateValue === undefined) return false;
  return metadataValue(fields[field]) !== metadataValue(templateValue);
}

function KeywordsEditor({ photoId, keywords }: { photoId: PhotoId; keywords: string[] }) {
  const store = useAppStore();
  const [draft, setDraft] = useState('');

  const add = (): void => {
    const value = draft.trim();
    if (!value) return;
    if (!keywords.includes(value)) {
      store.updateMetadataField(photoId, 'keywords', [...keywords, value]);
    }
    setDraft('');
  };

  return (
    <div className={styles.keywords}>
      <div className={styles.chips}>
        {keywords.map((keyword) => (
          <span key={keyword} className={styles.chip}>
            {keyword}
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={`Remove ${keyword}`}
              onClick={() =>
                store.updateMetadataField(
                  photoId,
                  'keywords',
                  keywords.filter((candidate) => candidate !== keyword),
                )
              }
            >
              <CloseIcon size={9} />
            </button>
          </span>
        ))}
        {keywords.length === 0 && <span className={styles.noKeywords}>No keywords</span>}
      </div>
      <TextInput
        placeholder="Add keyword…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add();
          } else if (event.key === 'Backspace' && draft === '' && keywords.length > 0) {
            store.updateMetadataField(photoId, 'keywords', keywords.slice(0, -1));
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

/** Full IPTC editor with template comparison and Photo Mechanic caption expansion. */
export function MetadataPanel({ className }: { className?: string }) {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const fields = photo ? (state.metadata[photo.id] ?? {}) : {};
  const template = state.template;
  const unresolved = photo ? (state.metadataUnresolved[photo.id] ?? []) : [];
  const [templateMode, setTemplateMode] = useState<'replace' | 'fillEmpty'>('fillEmpty');
  const templateOptions = [
    ...new Set(
      [
        ...(state.settings?.metadataTemplates ?? []),
        state.settings?.ingest.metadataTemplatePath,
        state.templatePath,
      ].filter((path): path is string => path !== undefined && path !== ''),
    ),
  ];
  const templatePath =
    state.templatePath ?? state.settings?.ingest.metadataTemplatePath ?? templateOptions[0];

  return (
    <Panel title="Metadata" className={className} testId="metadata-panel">
      {!photo ? (
        <p className={styles.empty}>Select a photo to edit its metadata.</p>
      ) : (
        <div data-testid="metadata-fields">
          <div className={styles.summary}>
            <span className={`${styles.fileName} mono`}>{photo.fileName}</span>
            <span className={styles.metaLine}>
              {photo.width && photo.height ? `${photo.width} × ${photo.height}` : 'Size unknown'}
              {photo.camera?.model ? ` · ${photo.camera.model}` : ''}
            </span>
            <span className={styles.metaLine}>
              {photo.captureTime?.replace('T', ' ') ?? 'No capture time'}
            </span>
          </div>

          <div className={styles.templateBar}>
            <Select
              className={styles.templateSelect}
              aria-label="Metadata template"
              data-testid="metadata-template-select"
              value={templatePath ?? ''}
              onChange={(event) => void store.selectMetadataTemplate(event.target.value)}
            >
              {templateOptions.length === 0 && <option value="">No template</option>}
              {templateOptions.map((path) => (
                <option key={path} value={path} title={path}>
                  {baseName(path)}
                </option>
              ))}
            </Select>
            <Button
              size="small"
              data-testid="metadata-template-browse"
              onClick={() => void store.browseMetadataTemplate()}
            >
              Browse…
            </Button>
          </div>

          <div className={styles.templateBar}>
            <Button
              size="small"
              data-testid="metadata-template-apply"
              disabled={!templatePath}
              onClick={() => void store.applyTemplate({ mode: templateMode })}
              title={
                state.selection.length > 1
                  ? `Apply to ${state.selection.length} selected photos`
                  : 'Apply to the current photo'
              }
            >
              Apply
            </Button>
            <Select
              className={styles.templateMode}
              aria-label="Template apply mode"
              value={templateMode}
              onChange={(event) => setTemplateMode(event.target.value as 'replace' | 'fillEmpty')}
            >
              <option value="fillEmpty">Fill empty</option>
              <option value="replace">Replace all</option>
            </Select>
            {photo.status.metadataDiffersFromTemplate && (
              <span
                className={styles.diffPill}
                title="Metadata no longer matches the ingest template"
              >
                differs
              </span>
            )}
          </div>

          {METADATA_SECTIONS.map((section) => (
            <PanelSection key={section.title} title={section.title}>
              {section.fields.map((field) => {
                const fieldDiffers = differs(field.name, fields, template);
                const value = metadataValue(fields[field.name]);
                const label = (
                  <span className={`${styles.label} ${fieldDiffers ? styles.labelDiff : ''}`}>
                    {field.label}
                    {fieldDiffers && (
                      <span
                        className={styles.diffMark}
                        title={`Template: ${metadataValue(template?.[field.name])}`}
                      >
                        ≠ template
                      </span>
                    )}
                  </span>
                );
                if (field.name === 'keywords') {
                  return (
                    <div key={field.name} className={styles.field}>
                      {label}
                      <KeywordsEditor photoId={photo.id} keywords={fields.keywords ?? []} />
                    </div>
                  );
                }
                return (
                  <label key={field.name} className={styles.field}>
                    {label}
                    {field.multiline ? (
                      <TextArea
                        data-caption-input={field.name === 'caption' ? true : undefined}
                        placeholder={field.placeholder}
                        value={value}
                        onChange={(event) =>
                          store.updateMetadataField(photo.id, field.name, event.target.value)
                        }
                        onBlur={() => {
                          if (field.name === 'caption') void store.expandCaption(photo.id);
                        }}
                        onKeyDown={(event) => {
                          if (
                            field.name === 'caption' &&
                            (event.ctrlKey || event.metaKey) &&
                            event.key === ' '
                          ) {
                            event.preventDefault();
                            void store.expandCaption(photo.id);
                          }
                        }}
                      />
                    ) : (
                      <TextInput
                        value={value}
                        onChange={(event) =>
                          store.updateMetadataField(photo.id, field.name, event.target.value)
                        }
                      />
                    )}
                  </label>
                );
              })}
              {section.title === 'Caption' && unresolved.length > 0 && (
                <div className={styles.unresolved} role="status">
                  <span>Unknown codes:</span>
                  {unresolved.map((token) => (
                    <code key={token} className={styles.unresolvedToken}>
                      {token}
                    </code>
                  ))}
                </div>
              )}
            </PanelSection>
          ))}
        </div>
      )}
    </Panel>
  );
}
