import type { IptcFields, PhotoId } from '@ee/contracts';
import { useState } from 'react';
import { activePhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { CloseIcon, WarningIcon } from './icons';
import { Panel } from './Panel';
import styles from './MetadataPanel.module.css';

type FieldName = keyof IptcFields;

interface FieldSpec {
  name: FieldName;
  label: string;
  placeholder?: string;
  multiline?: boolean;
}

const SECTIONS: { title: string; fields: FieldSpec[] }[] = [
  {
    title: 'Caption',
    fields: [
      { name: 'headline', label: 'Headline' },
      {
        name: 'caption',
        label: 'Caption',
        multiline: true,
        placeholder: '\\code\\ and {variables} are expanded on blur',
      },
      { name: 'keywords', label: 'Keywords' },
      { name: 'objectName', label: 'Object name' },
    ],
  },
  {
    title: 'Credits',
    fields: [
      { name: 'byline', label: 'Byline' },
      { name: 'bylineTitle', label: 'Byline title' },
      { name: 'credit', label: 'Credit' },
      { name: 'source', label: 'Source' },
      { name: 'copyright', label: 'Copyright' },
      { name: 'captionWriter', label: 'Caption writer' },
    ],
  },
  {
    title: 'Location',
    fields: [
      { name: 'city', label: 'City' },
      { name: 'state', label: 'State / province' },
      { name: 'country', label: 'Country' },
      { name: 'countryCode', label: 'Country code' },
      { name: 'location', label: 'Location' },
    ],
  },
  {
    title: 'Event / job',
    fields: [
      { name: 'event', label: 'Event' },
      { name: 'jobId', label: 'Job id' },
      { name: 'instructions', label: 'Instructions' },
      { name: 'dateCreated', label: 'Date created' },
    ],
  },
];

const valueOf = (value: IptcFields[FieldName] | undefined): string =>
  Array.isArray(value) ? value.join(', ') : (value ?? '');

function differs(field: FieldName, fields: IptcFields, template: IptcFields | undefined): boolean {
  if (!template) return false;
  const templateValue = template[field];
  if (templateValue === undefined) return false;
  return valueOf(fields[field]) !== valueOf(templateValue);
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
      <input
        className={styles.keywordInput}
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
  const templatePath = state.settings?.ingest.metadataTemplatePath ?? state.templatePath;

  return (
    <Panel title="Metadata" className={className} testId="metadata-panel">
      {!photo ? (
        <p className={styles.empty}>Select a photo to edit its metadata.</p>
      ) : (
        <div data-testid="metadata-fields">
          <div className={styles.summary}>
            <span className={styles.fileName}>{photo.fileName}</span>
            <span className={styles.metaLine}>
              {photo.width && photo.height ? `${photo.width} × ${photo.height}` : 'Size unknown'}
              {photo.camera?.model ? ` · ${photo.camera.model}` : ''}
            </span>
            <span className={styles.metaLine}>
              {photo.captureTime?.replace('T', ' ') ?? 'No capture time'}
            </span>
          </div>

          <div className={styles.templateBar}>
            <button
              type="button"
              className={styles.templateButton}
              disabled={!templatePath}
              onClick={() => void store.applyTemplate(templateMode, photo.id)}
            >
              Apply template…
            </button>
            <select
              className={styles.templateMode}
              aria-label="Template apply mode"
              value={templateMode}
              onChange={(event) => setTemplateMode(event.target.value as 'replace' | 'fillEmpty')}
            >
              <option value="fillEmpty">Fill empty</option>
              <option value="replace">Replace all</option>
            </select>
            {photo.status.metadataDiffersFromTemplate && (
              <span
                className={styles.diffPill}
                title="Metadata no longer matches the ingest template"
              >
                <WarningIcon size={10} /> differs
              </span>
            )}
          </div>

          {SECTIONS.map((section) => (
            <section key={section.title} className={styles.section}>
              <h3 className={styles.sectionTitle}>{section.title}</h3>
              {section.fields.map((field) => {
                const fieldDiffers = differs(field.name, fields, template);
                const value = valueOf(fields[field.name]);
                const label = (
                  <span className={`${styles.label} ${fieldDiffers ? styles.labelDiff : ''}`}>
                    {field.label}
                    {fieldDiffers && (
                      <span
                        className={styles.diffDot}
                        title={`Template: ${valueOf(template?.[field.name])}`}
                      />
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
                  <label
                    key={field.name}
                    className={`${styles.field} ${fieldDiffers ? styles.fieldDiff : ''}`}
                  >
                    {label}
                    {field.multiline ? (
                      <textarea
                        className={styles.input}
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
                      <input
                        className={styles.input}
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
                  <WarningIcon size={11} />
                  <span>Unknown codes:</span>
                  {unresolved.map((token) => (
                    <code key={token} className={styles.unresolvedToken}>
                      {token}
                    </code>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}
