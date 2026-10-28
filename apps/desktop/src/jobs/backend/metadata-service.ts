import type {
  ApplyTemplateArgs,
  ApplyTemplateResult,
  ExpandCaptionArgs,
  ExpandCaptionResult,
  IptcFields,
  Photo,
  PhotoId,
  WriteMetadataArgs,
} from '@ee/contracts';
import {
  diffFromTemplate,
  expandCaption,
  loadCodeReplacements,
  readIptc,
  readTemplate,
  writeIptc,
  applyTemplate,
  type ExifToolService,
} from '@ee/metadata';
import { stat } from 'node:fs/promises';
import type { TemplateApplyMode } from '@ee/contracts';
import type { PhotoLibrary } from './photo-library';
import type { SettingsStore } from './settings-store';

/** IPTC reading, writing, templates and caption expansion for indexed photos. */
export class MetadataService {
  private readonly templates = new Map<string, { mtimeMs: number; fields: IptcFields }>();

  constructor(
    private readonly photos: PhotoLibrary,
    private readonly exiftool: ExifToolService,
    private readonly settings: SettingsStore,
  ) {}

  async read(photoId: PhotoId): Promise<IptcFields> {
    return readIptc(this.photos.get(photoId).path, this.exiftool);
  }

  async write({ photoId, fields }: WriteMetadataArgs): Promise<Photo> {
    return this.photos.withLock(photoId, async () => {
      const photo = this.photos.get(photoId);
      await writeIptc(photo.path, fields, { service: this.exiftool });
      return this.refreshStatus(photoId);
    });
  }

  /** Parse a template file; re-reads only when the file changed. */
  async readTemplate(path: string): Promise<IptcFields> {
    const { mtimeMs } = await stat(path);
    const cached = this.templates.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.fields;
    const fields = await readTemplate(path, this.exiftool);
    this.templates.set(path, { mtimeMs, fields });
    return fields;
  }

  async applyTemplate(args: ApplyTemplateArgs): Promise<ApplyTemplateResult> {
    const fields = await this.readTemplate(args.templatePath);
    const result: ApplyTemplateResult = { updated: [], failed: [] };
    for (const photoId of args.photoIds) {
      try {
        await this.photos.withLock(photoId, async () => {
          const photo = this.photos.get(photoId);
          await applyTemplate(photo.path, fields, args.mode, { service: this.exiftool });
          this.photos.setTemplatePath(photoId, args.templatePath);
          await this.refreshStatus(photoId);
        });
        result.updated.push(photoId);
      } catch (error) {
        result.failed.push({
          photoId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  /**
   * Ingest-time variant of {@link applyTemplate}: the photo is not indexed yet,
   * so it works on the file. Returns whether the result still differs from the template.
   */
  async applyToFile(
    path: string,
    templatePath: string,
    mode: TemplateApplyMode,
  ): Promise<{ differs: boolean }> {
    const fields = await this.readTemplate(templatePath);
    await applyTemplate(path, fields, mode, { service: this.exiftool });
    return { differs: await this.differs(path, templatePath) };
  }

  async expandCaption(args: ExpandCaptionArgs): Promise<ExpandCaptionResult> {
    const photo = this.photos.get(args.photoId);
    const paths = args.codeReplacementPaths ?? this.settings.get().ingest.codeReplacementPaths;
    const [fields, codeReplacementSet] = await Promise.all([
      readIptc(photo.path, this.exiftool),
      loadCodeReplacements(paths),
    ]);
    const { text, unresolved } = expandCaption(args.text, {
      filePath: photo.path,
      fileName: photo.fileName,
      ...(photo.captureTime === undefined ? {} : { captureTime: photo.captureTime }),
      ...(photo.camera === undefined ? {} : { camera: photo.camera }),
      fields,
      codeReplacementSet,
    });
    return { text, unresolved };
  }

  /** True when the file's metadata no longer matches the template. */
  async differs(path: string, templatePath: string): Promise<boolean> {
    const [current, template] = await Promise.all([
      readIptc(path, this.exiftool),
      this.readTemplate(templatePath),
    ]);
    return diffFromTemplate(current, template).length > 0;
  }

  /** Recompute `metadataDiffersFromTemplate` from the files and publish the photo. */
  async refreshStatus(photoId: PhotoId): Promise<Photo> {
    const { photo, templatePath } = this.photos.record(photoId);
    let differs = false;
    if (templatePath !== undefined) {
      try {
        differs = await this.differs(photo.path, templatePath);
      } catch (error) {
        // A template that was moved or deleted cannot be compared against.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return this.photos.update(photoId, (current) => ({
      ...current,
      status: { ...current.status, metadataDiffersFromTemplate: differs },
    }));
  }
}
