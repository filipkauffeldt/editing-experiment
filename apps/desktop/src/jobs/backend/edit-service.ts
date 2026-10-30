import {
  IpcError,
  applyDevelopSettingGroups,
  asVersionId,
  type ApplyDevelopSettingsArgs,
  type CreateVersionArgs,
  type DeleteVersionArgs,
  type EditParams,
  type Photo,
  type PhotoId,
  type PhotoVersion,
  type RetouchOp,
  type RetouchVersion,
  type VersionId,
  type VersionRef,
} from '@ee/contracts';
import {
  readEditParams,
  readRawDefaults,
  readRetouchVersions,
  writeEditParams,
  writeRetouchVersions,
  type CropSpace,
  type ExifToolService,
} from '@ee/metadata';
import { randomUUID } from 'node:crypto';
import type { EditedPreviews } from './edited-previews';
import type { PhotoLibrary } from './photo-library';

/** The develop version of a photo. The sidecar holds exactly one set of `crs:` settings. */
export const developVersionId = (photoId: PhotoId): VersionId => asVersionId(`${photoId}:develop`);

function cropSpaceFor(photo: Photo): CropSpace {
  return {
    ...(photo.orientation === undefined ? {} : { orientation: photo.orientation }),
    ...(photo.width === undefined ? {} : { width: photo.width }),
    ...(photo.height === undefined ? {} : { height: photo.height }),
  };
}

/** True when the params change anything compared with a freshly ingested photo. */
export function hasDevelopEdits(params: EditParams): boolean {
  return Object.entries(params).some(([key, value]) => {
    if (value === undefined || key === 'ProcessVersion') return false;
    return !(key === 'WhiteBalance' && value === 'As Shot');
  });
}

/** True when any version of a photo holds edits. */
export function versionsEdited(versions: PhotoVersion[]): boolean {
  return versions.some((version) =>
    version.kind === 'develop' ? hasDevelopEdits(version.ops) : version.ops.length > 0,
  );
}

/** Develop and retouch edits, persisted in the photo's sidecar (`crs:` and `ee:`). */
export class EditService {
  constructor(
    private readonly photos: PhotoLibrary,
    private readonly exiftool: ExifToolService,
    private readonly previews: EditedPreviews,
  ) {}

  /** The versions stored next to a photo: its develop params plus every retouch version. */
  async readVersions(
    photoPath: string,
    photoId: PhotoId,
    cropSpace?: CropSpace,
  ): Promise<PhotoVersion[]> {
    const [params, retouch] = await Promise.all([
      readEditParams(photoPath, this.exiftool, cropSpace),
      readRetouchVersions(photoPath, this.exiftool),
    ]);
    return [{ id: developVersionId(photoId), kind: 'develop', ops: params }, ...retouch];
  }

  /** Camera and Lightroom raw defaults, read once per photo (the raw file does not change). */
  private readonly defaults = new Map<PhotoId, Promise<EditParams>>();

  async getDefaults(photoId: PhotoId): Promise<EditParams> {
    const photo = this.photos.get(photoId);
    let known = this.defaults.get(photoId);
    if (!known) {
      known = readRawDefaults(photo.path, this.exiftool);
      this.defaults.set(photoId, known);
      // A failed read must not stick.
      known.catch(() => this.defaults.delete(photoId));
    }
    return { ...(await known) };
  }

  async getParams(ref: VersionRef): Promise<EditParams> {
    const photo = this.photos.get(ref.photoId);
    this.assertDevelopVersion(ref);
    return readEditParams(photo.path, this.exiftool, cropSpaceFor(photo));
  }

  async setParams(ref: VersionRef & { params: EditParams }): Promise<void> {
    this.assertDevelopVersion(ref);
    await this.photos.withLock(ref.photoId, async () => {
      const photo = this.photos.get(ref.photoId);
      this.previews.noteParams(photo.id, ref.params);
      await writeEditParams(photo.path, ref.params, {
        service: this.exiftool,
        cropSpace: cropSpaceFor(photo),
      });
      // Re-read so the index shows what the sidecar says, not what was asked for.
      await this.publish(photo, await this.readVersions(photo.path, photo.id, cropSpaceFor(photo)));
    });
  }

  /**
   * Copy the selected setting groups from `args.params` onto each photo in one
   * call. Every photo is read, merged and written under its own lock; retouch
   * versions are not touched. Photos are written in the given order.
   */
  async applySettings(args: ApplyDevelopSettingsArgs): Promise<Photo[]> {
    const updated: Photo[] = [];
    for (const photoId of args.photoIds) {
      await this.photos.withLock(photoId, async () => {
        const photo = this.photos.get(photoId);
        const current = await readEditParams(photo.path, this.exiftool, cropSpaceFor(photo));
        const next = applyDevelopSettingGroups(current, args.params, args.groups);
        this.previews.noteParams(photo.id, next);
        await writeEditParams(photo.path, next, {
          service: this.exiftool,
          cropSpace: cropSpaceFor(photo),
        });
        updated.push(
          await this.publish(
            photo,
            await this.readVersions(photo.path, photo.id, cropSpaceFor(photo)),
          ),
        );
      });
    }
    return updated;
  }

  async getRetouch(ref: VersionRef): Promise<RetouchOp[]> {
    const photo = this.photos.get(ref.photoId);
    const versions = await readRetouchVersions(photo.path, this.exiftool);
    return this.pickRetouch(versions, ref)?.ops ?? [];
  }

  async setRetouch(ref: VersionRef & { ops: RetouchOp[] }): Promise<void> {
    await this.photos.withLock(ref.photoId, async () => {
      const photo = this.photos.get(ref.photoId);
      const versions = await readRetouchVersions(photo.path, this.exiftool);
      const target = this.pickRetouch(versions, ref);
      if (ref.versionId !== undefined && !target) {
        throw new IpcError('not_found', `no retouch version ${ref.versionId}`);
      }
      const next: RetouchVersion = target
        ? { ...target, ops: ref.ops }
        : { id: newRetouchId(photo.id), kind: 'retouch', ops: ref.ops };
      const all = target
        ? versions.map((v) => (v.id === target.id ? next : v))
        : [...versions, next];
      await writeRetouchVersions(photo.path, all, { service: this.exiftool });
      await this.publish(photo, await this.readVersions(photo.path, photo.id, cropSpaceFor(photo)));
    });
  }

  async createVersion(args: CreateVersionArgs): Promise<PhotoVersion> {
    if (args.kind === 'develop') {
      // The sidecar's `crs:` block is a single set of settings, so a second
      // develop version would have nowhere to live.
      throw new IpcError(
        'invalid_argument',
        'a photo has exactly one develop version (the crs: settings in its sidecar)',
      );
    }
    return this.photos.withLock(args.photoId, async () => {
      const photo = this.photos.get(args.photoId);
      const versions = await readRetouchVersions(photo.path, this.exiftool);
      const created: RetouchVersion = {
        id: newRetouchId(photo.id),
        kind: 'retouch',
        ...(args.name === undefined ? {} : { name: args.name }),
        ops: [],
      };
      await writeRetouchVersions(photo.path, [...versions, created], { service: this.exiftool });
      await this.publish(photo, await this.readVersions(photo.path, photo.id, cropSpaceFor(photo)));
      return created;
    });
  }

  async deleteVersion(args: DeleteVersionArgs): Promise<Photo> {
    if (args.versionId === developVersionId(args.photoId)) {
      throw new IpcError('invalid_argument', 'the develop version cannot be deleted');
    }
    return this.photos.withLock(args.photoId, async () => {
      const photo = this.photos.get(args.photoId);
      const versions = await readRetouchVersions(photo.path, this.exiftool);
      if (!versions.some((version) => version.id === args.versionId)) {
        throw new IpcError('not_found', `no retouch version ${args.versionId}`);
      }
      await writeRetouchVersions(
        photo.path,
        versions.filter((version) => version.id !== args.versionId),
        { service: this.exiftool },
      );
      return this.publish(
        photo,
        await this.readVersions(photo.path, photo.id, cropSpaceFor(photo)),
      );
    });
  }

  private assertDevelopVersion(ref: VersionRef): void {
    if (ref.versionId !== undefined && ref.versionId !== developVersionId(ref.photoId)) {
      throw new IpcError('not_found', `no develop version ${ref.versionId}`);
    }
  }

  /** The addressed retouch version, or the first one when none is named. */
  private pickRetouch(versions: RetouchVersion[], ref: VersionRef): RetouchVersion | undefined {
    if (ref.versionId === undefined) return versions[0];
    return versions.find((version) => version.id === ref.versionId);
  }

  private async publish(photo: Photo, versions: PhotoVersion[]): Promise<Photo> {
    const edited = versionsEdited(versions);
    // Callers hold the photo lock, so the cached previews cannot change under us.
    const previewFields = await this.previews.afterVersionsChanged(
      this.photos.get(photo.id),
      versions,
      edited,
    );
    return this.photos.update(photo.id, (current) => ({
      ...current,
      versions,
      status: { ...current.status, edited },
      ...previewFields,
    }));
  }
}

const newRetouchId = (photoId: PhotoId): VersionId =>
  asVersionId(`${photoId}:retouch:${randomUUID().slice(0, 8)}`);
