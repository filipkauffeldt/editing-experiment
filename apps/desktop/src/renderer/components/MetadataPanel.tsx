import type { IptcFields, Photo, PhotoId } from '@ee/contracts';
import { useState } from 'react';
import {
  METADATA_SECTIONS,
  metadataValue,
  type MetadataFieldName,
  type MetadataFieldSpec,
} from '../metadata-fields';
import { useMetadataGroupOpen } from '../metadata-view';
import { activePhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { CloseIcon } from './icons';
import { Panel } from './Panel';
import { Button } from './ui/Button';
import { Select, TextArea, TextInput } from './ui/Field';
import { Menu, MenuItem } from './ui/Menu';
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

/**
 * Chips and an add field for one photo's keywords. `shortcutTarget` is false where Ctrl/Cmd+K
 * opens a dialog instead of focusing this field.
 */
export function KeywordsEditor({
  photoId,
  keywords,
  shortcutTarget = true,
}: {
  photoId: PhotoId;
  keywords: string[];
  shortcutTarget?: boolean;
}) {
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
        data-keywords-input={shortcutTarget ? true : undefined}
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

/** The labelled editor of one field; a field that differs from the template says so. */
function FieldRow({
  photo,
  field,
  fields,
  template,
}: {
  photo: Photo;
  field: MetadataFieldSpec;
  fields: IptcFields;
  template: IptcFields | undefined;
}) {
  const store = useAppStore();
  const fieldDiffers = differs(field.name, fields, template);
  const value = metadataValue(fields[field.name]);
  const label = (
    <span className={`${styles.label} ${fieldDiffers ? styles.labelDiff : ''}`}>
      {field.label}
      {fieldDiffers && (
        <span
          className={styles.diffMark}
          title={`Differs from template: ${metadataValue(template?.[field.name]) || 'empty'}`}
        >
          ≠ template
        </span>
      )}
    </span>
  );
  if (field.name === 'keywords') {
    return (
      <div className={styles.field}>
        {label}
        <KeywordsEditor photoId={photo.id} keywords={fields.keywords ?? []} />
      </div>
    );
  }
  return (
    <label className={styles.field}>
      {label}
      {field.multiline ? (
        <TextArea
          className={field.name === 'caption' ? styles.caption : undefined}
          data-caption-input={field.name === 'caption' ? true : undefined}
          placeholder={field.placeholder}
          value={value}
          onChange={(event) => store.updateMetadataField(photo.id, field.name, event.target.value)}
          onBlur={() => {
            if (field.name === 'caption') void store.expandCaption(photo.id);
          }}
          onKeyDown={(event) => {
            if (field.name === 'caption' && (event.ctrlKey || event.metaKey) && event.key === ' ') {
              event.preventDefault();
              void store.expandCaption(photo.id);
            }
          }}
        />
      ) : (
        <TextInput
          value={value}
          onChange={(event) => store.updateMetadataField(photo.id, field.name, event.target.value)}
        />
      )}
    </label>
  );
}

/**
 * A group the template usually fills (Credits, Location, Event / job), folded until opened. The
 * header carries what a fold would hide: the values that are set, and `≠ template` when one of
 * them no longer matches the template, so a difference is never out of sight.
 */
function FoldedGroup({
  photo,
  title,
  fields: specs,
  values,
  template,
}: {
  photo: Photo;
  title: string;
  fields: readonly MetadataFieldSpec[];
  values: IptcFields;
  template: IptcFields | undefined;
}) {
  const [open, setOpen] = useMetadataGroupOpen(title);
  const different = specs.filter((field) => differs(field.name, values, template));
  const summary = specs
    .map((field) => metadataValue(values[field.name]))
    .filter((value) => value !== '')
    .join(' · ');
  return (
    <PanelSection
      title={title}
      open={open}
      onOpenChange={setOpen}
      testId={`metadata-group-${title.toLowerCase().replace(/\W+/g, '-')}`}
      actions={
        <span className={styles.groupInfo}>
          {different.length > 0 && (
            <span
              className={styles.diffMark}
              data-testid="metadata-group-differs"
              title={[
                'Differs from template:',
                ...different.map(
                  (field) =>
                    `${field.label} (template: ${metadataValue(template?.[field.name]) || 'empty'})`,
                ),
              ].join('\n')}
            >
              ≠ template
            </span>
          )}
          {!open && summary !== '' && (
            <span className={styles.groupSummary} data-testid="metadata-group-summary">
              {summary}
            </span>
          )}
        </span>
      }
    >
      {specs.map((field) => (
        <FieldRow
          key={field.name}
          photo={photo}
          field={field}
          fields={values}
          template={template}
        />
      ))}
    </PanelSection>
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
  const copied = state.copiedMetadata;
  const copiedCount = copied ? Object.keys(copied.fields).length : 0;
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
  const [primary, ...folded] = METADATA_SECTIONS;

  return (
    <Panel className={className} testId="metadata-panel">
      {!photo ? (
        <p className={styles.empty}>Select a photo to edit its metadata.</p>
      ) : (
        <div data-testid="metadata-fields">
          <div className={styles.toolbar} data-testid="metadata-toolbar">
            <div className={styles.row} data-testid="metadata-template-row">
              {templateOptions.length === 0 ? (
                <button
                  type="button"
                  className={styles.templateLink}
                  data-testid="metadata-template-settings"
                  title="No metadata template yet: add one in Settings → Metadata"
                  onClick={() => store.openDialog('metadata')}
                >
                  Set up templates
                </button>
              ) : (
                <Select
                  className={styles.templateSelect}
                  aria-label="Metadata template"
                  data-testid="metadata-template-select"
                  title={templatePath ?? ''}
                  value={templatePath ?? ''}
                  onChange={(event) => void store.selectMetadataTemplate(event.target.value)}
                >
                  {templateOptions.map((path) => (
                    <option key={path} value={path} title={path}>
                      {baseName(path)}
                    </option>
                  ))}
                </Select>
              )}
              {photo.status.metadataDiffersFromTemplate && (
                <span
                  className={styles.diffPill}
                  title="Differs from template"
                  data-testid="metadata-differs"
                >
                  ≠
                </span>
              )}
              <span className={styles.split}>
                <Button
                  size="small"
                  data-testid="metadata-template-apply"
                  disabled={!templatePath}
                  onClick={() => void store.applyTemplate({ mode: 'fillEmpty' })}
                  title={`${
                    state.selection.length > 1
                      ? `Apply to ${state.selection.length} selected photos`
                      : 'Apply to the current photo'
                  } · fills empty fields, keeps what is written`}
                >
                  Apply
                </Button>
                <Menu
                  label=""
                  compact
                  closeOnPick
                  align="right"
                  ariaLabel="Apply options"
                  testId="metadata-apply-mode"
                >
                  {/*
                    A plain Apply never overwrites a caption written by hand. Overwriting is a
                    deliberate second step, and it is named as such. Ingest has its own mode.
                  */}
                  <MenuItem
                    kind="action"
                    onSelect={() => void store.applyTemplate({ mode: 'fillEmpty' })}
                  >
                    Fill empty fields
                  </MenuItem>
                  <MenuItem
                    kind="action"
                    onSelect={() => void store.applyTemplate({ mode: 'replace' })}
                  >
                    Replace all, overwriting
                  </MenuItem>
                </Menu>
              </span>
            </div>
            <div className={styles.row} data-testid="metadata-copy-row">
              <Button
                size="small"
                data-testid="metadata-copy"
                onClick={() => store.openMetadataCopy()}
              >
                Copy metadata…
              </Button>
              <Button
                size="small"
                data-testid="metadata-paste"
                disabled={!copied}
                title={
                  copied
                    ? `Paste ${copiedCount} field${copiedCount === 1 ? '' : 's'} from ${copied.sourceName}`
                    : 'Copy metadata first'
                }
                onClick={() => void store.pasteMetadata()}
              >
                Paste
              </Button>
            </div>
          </div>

          <div className={styles.primary}>
            {primary?.fields.map((field) => (
              <FieldRow
                key={field.name}
                photo={photo}
                field={field}
                fields={fields}
                template={template}
              />
            ))}
            {unresolved.length > 0 && (
              <div className={styles.unresolved} role="status">
                <span>Unknown codes:</span>
                {unresolved.map((token) => (
                  <code key={token} className={styles.unresolvedToken}>
                    {token}
                  </code>
                ))}
              </div>
            )}
          </div>

          {folded.map((section) => (
            <FoldedGroup
              key={section.title}
              photo={photo}
              title={section.title}
              fields={section.fields}
              values={fields}
              template={template}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
