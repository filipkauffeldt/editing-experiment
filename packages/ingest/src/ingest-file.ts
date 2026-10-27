import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  asPhotoId,
  type IngestConfig,
  type IngestDestination,
  type JobId,
  type SourceConfig,
} from '@ee/contracts';
import { copyPhotoLocal } from './copy';
import { safeFileBase, safeSubfolder } from './naming';
import { createTemplateContext, type ExpandTemplate, type TemplateContext } from './template';
import type { FileCopier, IngestedFileInfo } from './types';

export function destinationDirectory(
  destination: IngestDestination,
  context: TemplateContext,
  expandTemplate: ExpandTemplate,
): string {
  const expanded = destination.subfolderTemplate
    ? expandTemplate(destination.subfolderTemplate, context)
    : '';
  const subfolder = safeSubfolder(expanded);
  return subfolder ? join(destination.path, subfolder) : destination.path;
}

export interface IngestFileRequest {
  jobId: JobId;
  source: SourceConfig;
  /** Local file holding the bytes, which may be a downloaded temp file. */
  sourcePath: string;
  sourceFileName: string;
  /** Absolute path for local sources, remote path for remote sources. */
  sourceDisplayPath: string;
  sidecarSourcePath?: string;
  sidecarDisplayPath?: string;
  /** Size captured before the copy, so a later stat cannot drop the seen entry. */
  sidecarSize?: number;
  seq: number;
  size: number;
  mtimeMs: number;
  capturedAt?: Date;
}

export interface IngestFileDeps {
  config: IngestConfig;
  expandTemplate: ExpandTemplate;
  copier: FileCopier;
  signal?: AbortSignal;
  now: Date;
}

export async function ingestFile(
  request: IngestFileRequest,
  deps: IngestFileDeps,
): Promise<IngestedFileInfo> {
  const context = createTemplateContext({
    sourceId: request.source.id,
    sourceName: request.source.name,
    sourcePath: request.sourceDisplayPath,
    fileName: request.sourceFileName,
    seq: request.seq,
    mtimeMs: request.mtimeMs,
    now: deps.now,
    ...(request.capturedAt ? { capturedAt: request.capturedAt } : {}),
  });
  const finalBase = safeFileBase(deps.expandTemplate(deps.config.renameTemplate, context));
  const primaryDirectory = destinationDirectory(
    deps.config.destination,
    context,
    deps.expandTemplate,
  );
  const backupDirectory = deps.config.backupDestination
    ? destinationDirectory(deps.config.backupDestination, context, deps.expandTemplate)
    : undefined;

  const result = await copyPhotoLocal(
    {
      sourcePath: request.sourcePath,
      sourceFileName: request.sourceFileName,
      ...(request.sidecarSourcePath ? { sidecarSourcePath: request.sidecarSourcePath } : {}),
      finalBase,
      primaryDirectory,
      ...(backupDirectory ? { backupDirectory } : {}),
    },
    {
      copier: deps.copier,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  );

  return {
    photoId: asPhotoId(randomUUID()),
    jobId: request.jobId,
    sourceId: request.source.id,
    sourceKind: request.source.kind,
    sourceName: request.source.name,
    sourcePath: request.sourceDisplayPath,
    sourceFileName: request.sourceFileName,
    path: result.path,
    fileName: result.fileName,
    ...(result.sidecarPath ? { sidecarPath: result.sidecarPath } : {}),
    ...(result.backupPath ? { backupPath: result.backupPath } : {}),
    ...(result.backupSidecarPath ? { backupSidecarPath: result.backupSidecarPath } : {}),
    size: result.size,
    ...(request.sidecarSize !== undefined ? { sidecarSize: request.sidecarSize } : {}),
    mtimeMs: request.mtimeMs,
    sha256: result.sha256,
    seq: request.seq,
  };
}
