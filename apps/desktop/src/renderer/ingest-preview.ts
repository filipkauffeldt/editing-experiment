import { asSourceId, type SourceConfig } from '@ee/contracts';
import { previewIngestPath, type IngestPathPreview } from '@ee/ingest/destination-path';
import { createTemplateContext } from '@ee/ingest/template';
import { expandIngestTemplate } from '../shared/ingest-template';
import type { IngestForm } from './use-ingest-settings';

/** The card's own first file is not known before the copy, so the preview names one like it. */
export const EXAMPLE_FILE_NAME = '_DSC0001.NEF';

const sourceLocation = (source: SourceConfig): string =>
  source.kind === 'folder'
    ? source.path
    : source.kind === 'card'
      ? source.mountPath
      : source.remotePath;

/**
 * Where the first file of the first ticked source lands, with the expansion ingest uses. Without a
 * ticked source it is an example card. The date is today's: ingest uses each file's own.
 */
export function ingestPreview(
  form: IngestForm,
  source: SourceConfig | undefined,
  now: Date,
): IngestPathPreview {
  return previewIngestPath({
    destination: {
      path: form.destination,
      subfolderTemplate: form.subfolder.trim() || undefined,
    },
    fileNaming: form.fileNaming,
    renameTemplate: form.renameTemplate,
    expandTemplate: expandIngestTemplate,
    context: createTemplateContext({
      sourceId: source?.id ?? asSourceId('example'),
      sourceName: source?.name ?? 'Card',
      sourcePath: source ? sourceLocation(source) : '',
      fileName: EXAMPLE_FILE_NAME,
      seq: 1,
      mtimeMs: now.getTime(),
      now,
    }),
  });
}
