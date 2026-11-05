import {
  asPresetId,
  type FileNamingMode,
  type IngestSettings,
  type TemplateApplyMode,
} from '@ee/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useAppStore } from './store-context';

/** The ingest settings as the form holds them: text fields stay strings while being typed. */
export interface IngestForm {
  destination: string;
  subfolder: string;
  backup: string;
  fileNaming: FileNamingMode;
  renameTemplate: string;
  metadataTemplatePath: string;
  metadataTemplateMode: TemplateApplyMode;
  developPresetId: string;
}

const EMPTY_FORM: IngestForm = {
  destination: '',
  subfolder: '',
  backup: '',
  fileNaming: 'rename',
  renameTemplate: '{date}_{seq:4}',
  metadataTemplatePath: '',
  metadataTemplateMode: 'replace',
  developPresetId: '',
};

/** Quiet time after the last edit before the settings are written. */
export const AUTOSAVE_DELAY_MS = 500;

export const toForm = (ingest: IngestSettings): IngestForm => ({
  destination: ingest.destination.path,
  subfolder: ingest.destination.subfolderTemplate ?? '',
  backup: ingest.backupDestination?.path ?? '',
  fileNaming: ingest.fileNaming,
  renameTemplate: ingest.renameTemplate,
  metadataTemplatePath: ingest.metadataTemplatePath ?? '',
  metadataTemplateMode: ingest.metadataTemplateMode ?? 'replace',
  developPresetId: ingest.developPresetId ?? '',
});

export interface IngestFormErrors {
  destination?: string;
  renameTemplate?: string;
}

/** What the settings are once trimmed, or what is missing. Nothing invalid is ever saved. */
export function buildIngestSettings(
  form: IngestForm,
):
  | { settings: IngestSettings; errors?: undefined }
  | { settings?: undefined; errors: IngestFormErrors } {
  const errors: IngestFormErrors = {};
  if (!form.destination.trim()) errors.destination = 'Destination folder is required';
  if (form.fileNaming === 'rename' && !form.renameTemplate.trim()) {
    errors.renameTemplate = 'Rename template is required';
  }
  if (errors.destination || errors.renameTemplate) return { errors };
  return {
    settings: {
      destination: {
        path: form.destination.trim(),
        subfolderTemplate: form.subfolder.trim() || undefined,
      },
      backupDestination: form.backup.trim() ? { path: form.backup.trim() } : undefined,
      fileNaming: form.fileNaming,
      renameTemplate: form.renameTemplate.trim(),
      metadataTemplatePath: form.metadataTemplatePath.trim() || undefined,
      metadataTemplateMode: form.metadataTemplateMode,
      developPresetId: form.developPresetId ? asPresetId(form.developPresetId) : undefined,
    },
  };
}

/** Compares forms by what would be saved, so a trailing space is not an edit. */
const formKey = (form: IngestForm): string =>
  JSON.stringify([
    form.destination.trim(),
    form.subfolder.trim(),
    form.backup.trim(),
    form.fileNaming,
    form.renameTemplate.trim(),
    form.metadataTemplatePath.trim(),
    form.metadataTemplateMode,
    form.developPresetId,
  ]);

export type FlushResult =
  | { ok: true; settings: IngestSettings }
  | { ok: false; reason: 'invalid' | 'failed'; message: string };

export interface IngestSettingsController {
  form: IngestForm;
  /** The settings on screen once valid; `undefined` while a required field is empty. */
  settings: IngestSettings | undefined;
  errors: IngestFormErrors;
  /** Why the last write failed; cleared by the next one that works. */
  saveError: string | undefined;
  set<K extends keyof IngestForm>(field: K, value: IngestForm[K]): void;
  /** Writes what is on screen now and answers with exactly that. */
  flush(): Promise<FlushResult>;
}

/**
 * The ingest settings form with no Save button: an edit is written after a short quiet time,
 * and starting an ingest flushes first and uses what is on screen. A save that fails is kept in
 * `saveError` and tried again by the next edit or flush. Leaving the view writes a pending edit.
 */
export function useIngestSettings(): IngestSettingsController {
  const store = useAppStore();
  const persisted = useAppState().settings?.ingest;
  const [form, setForm] = useState<IngestForm>(() => (persisted ? toForm(persisted) : EMPTY_FORM));
  const [saveError, setSaveError] = useState<string>();
  const formRef = useRef(form);
  /** Key of the settings the backend is known to hold. */
  const savedKey = useRef(persisted ? formKey(toForm(persisted)) : undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const persistedKey = persisted ? formKey(toForm(persisted)) : undefined;

  // Settings that arrive or change elsewhere replace the form, unless there is an edit of its own
  // that has not been saved yet (a save of that edit comes back through here too).
  useEffect(() => {
    if (!persisted || persistedKey === undefined) return;
    const edited = savedKey.current !== undefined && formKey(formRef.current) !== savedKey.current;
    savedKey.current = persistedKey;
    if (edited || formKey(formRef.current) === persistedKey) return;
    formRef.current = toForm(persisted);
    setForm(formRef.current);
  }, [persisted, persistedKey]);

  const write = useCallback((): Promise<FlushResult> => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    const run = async (): Promise<FlushResult> => {
      const current = formRef.current;
      const built = buildIngestSettings(current);
      if (!built.settings) {
        return { ok: false, reason: 'invalid', message: Object.values(built.errors)[0] ?? '' };
      }
      if (formKey(current) === savedKey.current) {
        setSaveError(undefined);
        return { ok: true, settings: built.settings };
      }
      try {
        await store.saveSettings({ ingest: built.settings });
        savedKey.current = formKey(current);
        setSaveError(undefined);
        return { ok: true, settings: built.settings };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setSaveError(message);
        return { ok: false, reason: 'failed', message };
      }
    };
    const result = queue.current.then(run, run);
    queue.current = result;
    return result;
  }, [store]);

  useEffect(
    () => () => {
      if (timer.current === undefined) return;
      void write().then((result) => {
        if (!result.ok && result.reason === 'failed') {
          store.notify('error', `Could not save the ingest settings: ${result.message}`);
        }
      });
    },
    [store, write],
  );

  const set = useCallback(
    <K extends keyof IngestForm>(field: K, value: IngestForm[K]): void => {
      formRef.current = { ...formRef.current, [field]: value };
      setForm(formRef.current);
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(() => void write(), AUTOSAVE_DELAY_MS);
    },
    [write],
  );

  const built = useMemo(() => buildIngestSettings(form), [form]);
  return {
    form,
    settings: built.settings,
    errors: built.errors ?? {},
    saveError,
    set,
    flush: write,
  };
}
