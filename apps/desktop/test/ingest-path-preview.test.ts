// @vitest-environment node
import { asSourceId, type IngestConfig } from '@ee/contracts';
import { createTemplateContext, previewIngestPath, startIngest } from '@ee/ingest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandIngestTemplate } from '../src/shared/ingest-template';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SHOT = new Date(2026, 10, 4, 19, 30);

/** Runs a real ingest of one file and returns the path it was copied to. */
async function ingestOne(
  settings: Pick<IngestConfig, 'fileNaming' | 'renameTemplate'> & { subfolderTemplate?: string },
): Promise<{ landed: string; previewed: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ee-ingest-preview-'));
  roots.push(root);
  const source = join(root, 'card');
  await mkdir(source);
  await writeFile(join(source, '_DSC9694.NEF'), 'bytes');
  await utimes(join(source, '_DSC9694.NEF'), SHOT, SHOT);
  const destination = {
    path: join(root, 'Photos'),
    ...(settings.subfolderTemplate ? { subfolderTemplate: settings.subfolderTemplate } : {}),
  };
  const landed: string[] = [];
  const handle = startIngest(
    {
      sources: [{ kind: 'folder', id: asSourceId('card-1'), name: 'NIKON Z 6', path: source }],
      destination,
      fileNaming: settings.fileNaming,
      renameTemplate: settings.renameTemplate,
    },
    {
      expandTemplate: expandIngestTemplate,
      onFileIngested: async (info) => {
        landed.push(info.path);
      },
    },
  );
  await handle.done;
  const preview = previewIngestPath({
    destination,
    fileNaming: settings.fileNaming,
    renameTemplate: settings.renameTemplate,
    expandTemplate: expandIngestTemplate,
    context: createTemplateContext({
      sourceId: asSourceId('card-1'),
      sourceName: 'NIKON Z 6',
      sourcePath: source,
      fileName: '_DSC9694.NEF',
      seq: 1,
      mtimeMs: SHOT.getTime(),
      now: new Date(),
    }),
  });
  if (!preview.ok) throw new Error(preview.message);
  return { landed: landed[0] ?? '', previewed: preview.path };
}

describe('the Ingest preview and a real ingest', () => {
  it('agree when the names are kept, with a dated subfolder', async () => {
    const { landed, previewed } = await ingestOne({
      fileNaming: 'keep',
      renameTemplate: '',
      subfolderTemplate: '{date}_{sourceName}',
    });
    expect(landed).toContain('2026-11-04_NIKON Z 6');
    expect(previewed).toBe(landed);
  });

  it('agree when the files are renamed', async () => {
    const { landed, previewed } = await ingestOne({
      fileNaming: 'rename',
      renameTemplate: '{date:YYYYMMDD}_{filenamebase}_{seq:4}',
    });
    expect(landed.endsWith('20261104__DSC9694_0001.NEF')).toBe(true);
    expect(previewed).toBe(landed);
  });
});
