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
import { safeFileBase, safeSubfolder, splitName } from './naming';
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
  /** The sidecar's modified time on the source, when there is a sidecar. */
  sidecarMtimeMs?: number;
  capturedAt?: Date;
}

export interface IngestFileDeps {
  config: IngestConfig;
  expandTemplate: ExpandTemplate;
  copier: FileCopier;
  signal?: AbortSignal;
  now: Date;
  /** A problem that does not fail the ingest. */
  onWarning?: (message: string) => void;
  /**
   * Base names already chosen in one run, keyed by destination directory,
   * source and original base. A raw/JPEG pair from the same source then gets
   * the same collision suffix even while another source races for the name.
   */
  baseNames?: Map<string, string>;
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
  const primaryDirectory = destinationDirectory(
    deps.config.destination,
    context,
    deps.expandTemplate,
  );
  const backupDirectory = deps.config.backupDestination
    ? destinationDirectory(deps.config.backupDestination, context, deps.expandTemplate)
    : undefined;

  const originalBase = splitName(request.sourceFileName).base;
  const reservationKey = `${request.source.id}\u0000${primaryDirectory}\u0000${originalBase}`;
  let finalBase: string;
  if (deps.config.fileNaming === 'keep') {
    // Keeping the original base name still runs through the file-name guard: it
    // is a real name, but must never become a path or an empty name.
    finalBase = deps.baseNames?.get(reservationKey) ?? safeFileBase(originalBase);
    deps.baseNames?.set(reservationKey, finalBase);
  } else {
    finalBase = safeFileBase(deps.expandTemplate(deps.config.renameTemplate, context));
  }

  const result = await copyPhotoLocal(
    {
      sourcePath: request.sourcePath,
      sourceFileName: request.sourceFileName,
      ...(request.sidecarSourcePath ? { sidecarSourcePath: request.sidecarSourcePath } : {}),
      mtimeMs: request.mtimeMs,
      ...(request.sidecarMtimeMs === undefined ? {} : { sidecarMtimeMs: request.sidecarMtimeMs }),
      finalBase,
      primaryDirectory,
      ...(backupDirectory ? { backupDirectory } : {}),
    },
    {
      ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
      copier: deps.copier,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  );

  if (deps.config.fileNaming === 'keep') {
    // A concurrent source may have taken the name, moving this copy to `_1`;
    // the rest of this source's pair must follow it.
    deps.baseNames?.set(reservationKey, splitName(result.fileName).base);
  }

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
