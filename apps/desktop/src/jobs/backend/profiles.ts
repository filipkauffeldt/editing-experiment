import {
  IpcError,
  type CameraInfo,
  type CameraProfileData,
  type LookProfileData,
  type PhotoProfiles,
  type ProfileGroup,
  type ProfileIndex,
  type ProfileListing,
  type ProfileProblem,
  type ProfileRequest,
  type ProfileResolution,
} from '@ee/contracts';
import { identifyDcp, parseDcp, parseLookXmp, ProfileParseError } from '@ee/develop-gl/profile';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The user's camera profiles: Adobe DNG camera profiles (`.dcp`) and XMP profiles (`.xmp` looks) found
 * below a few folders. The files are Adobe's (or the user's); they are read where they are, never
 * copied into the app, the repository or userData. Parsed profiles are kept in memory only.
 */

/** Where Adobe's Camera Raw keeps its profiles on this platform, if it is installed. */
export function defaultProfileFolders(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'darwin') {
    return [
      '/Library/Application Support/Adobe/CameraRaw/CameraProfiles',
      join(home, 'Library', 'Application Support', 'Adobe', 'CameraRaw', 'CameraProfiles'),
    ];
  }
  if (platform === 'win32') {
    const folders: string[] = [];
    folders.push(
      join(env['ProgramData'] ?? 'C:\\ProgramData', 'Adobe', 'CameraRaw', 'CameraProfiles'),
    );
    if (env['APPDATA']) folders.push(join(env['APPDATA'], 'Adobe', 'CameraRaw', 'CameraProfiles'));
    return folders;
  }
  // TODO(linux): Adobe has no Linux installer; the user copies the folder over and adds it in Settings.
  return [];
}

const MAX_DEPTH = 8;
const HEAD_BYTES = 64 * 1024;

/** `NIKON Z 6_2`, `Nikon Z 6 II`, `Z 6_2` -> lower case letters and digits only. */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether a profile made for `profileCamera` (its `UniqueCameraModel`) fits the photo's camera: make
 * and model, or the model alone, compared without case, spaces or underscores (LibRaw's `Z 6_2` is
 * Adobe's `Z 6 2`). An empty `profileCamera` fits any camera (a look without a restriction).
 */
export function cameraFits(profileCamera: string, camera: CameraInfo | undefined): boolean {
  if (profileCamera === '') return true;
  if (!camera?.model) return false;
  const wanted = squash(profileCamera);
  const make = squash((camera.make ?? '').replace(/\b(corporation|corp|co|ltd)\b/gi, ''));
  const model = squash(camera.model);
  // EXIF models often repeat the make ("NIKON Z 6_2"); the profile may name either form.
  const short = make !== '' && model.startsWith(make) ? model.slice(make.length) : model;
  return wanted === model || wanted === short || wanted === make + short;
}

function groupOfCamera(name: string, path: string): ProfileGroup {
  if (/camera matching/i.test(path) || /^camera /i.test(name)) return 'camera-matching';
  if (/^adobe /i.test(name)) return 'adobe-raw';
  return 'other';
}

function groupOfLook(look: LookProfileData, path: string): ProfileGroup {
  if (/adobe raw/i.test(path) || /^adobe /i.test(look.name) || look.group === 'Profiles') {
    return /camera /i.test(look.name) ? 'camera-matching' : 'adobe-raw';
  }
  return 'other';
}

interface Found {
  listing: ProfileListing;
  /** Cached parse, keyed by the file's identity so a changed file is read again. */
  stamp: string;
}

/** What the scan keeps of a file. */
type Scanned =
  | { kind: 'camera'; listing: ProfileListing; stamp: string }
  | { kind: 'look'; listing: ProfileListing; stamp: string; data: LookProfileData }
  | { kind: 'problem'; problem: ProfileProblem };

export interface ProfileLibraryOptions {
  /** The user's extra folders (settings). */
  folders: () => readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export class ProfileLibrary {
  private scan: Promise<ProfileIndex> | undefined;
  private foldersKey = '';
  private readonly look = new Map<string, LookProfileData>();
  private readonly camera = new Map<string, { stamp: string; data: CameraProfileData }>();
  private readonly identified = new Map<string, Found>();

  constructor(private readonly options: ProfileLibraryOptions) {}

  /** Folders that are scanned: Adobe's own where they exist, then the user's, without repeats. */
  folders(): string[] {
    const defaults = defaultProfileFolders(
      this.options.platform,
      this.options.env,
      this.options.home,
    );
    return [...new Set([...defaults, ...this.options.folders()])];
  }

  /** Scans the folders (once per set of folders until `rescan`). */
  index(rescan = false): Promise<ProfileIndex> {
    const key = this.folders().join('\n');
    if (rescan || !this.scan || key !== this.foldersKey) {
      this.foldersKey = key;
      this.scan = this.run();
    }
    return this.scan;
  }

  private async run(): Promise<ProfileIndex> {
    const folders = this.folders();
    const profiles: ProfileListing[] = [];
    const problems: ProfileProblem[] = [];
    const existing: string[] = [];
    for (const folder of folders) {
      const files: string[] = [];
      try {
        await collect(folder, 0, files);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        problems.push({ path: folder, reason: describe(error) });
        continue;
      }
      existing.push(folder);
      for (const path of files) {
        const scanned = await this.identify(path);
        if (scanned === undefined) continue;
        if (scanned.kind === 'problem') problems.push(scanned.problem);
        else profiles.push(scanned.listing);
      }
    }
    // One entry per file, however many folders reach it.
    const unique = [...new Map(profiles.map((p) => [p.id, p])).values()];
    unique.sort((a, b) => a.name.localeCompare(b.name) || a.camera.localeCompare(b.camera));
    return { profiles: unique, problems, folders: existing };
  }

  private async identify(path: string): Promise<Scanned | undefined> {
    const lower = path.toLowerCase();
    try {
      const info = await stat(path);
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (lower.endsWith('.dcp')) {
        const cached = this.identified.get(path);
        if (cached?.stamp === stamp) return { kind: 'camera', ...cached };
        const head = await readHead(path);
        let id = tryIdentify(head, true);
        if (!id) id = tryIdentify(new Uint8Array(await readFile(path)), false);
        if (!id) return { kind: 'problem', problem: { path, reason: 'Not a DNG camera profile' } };
        const listing: ProfileListing = {
          id: path,
          name: id.name,
          kind: 'camera',
          group: groupOfCamera(id.name, path),
          camera: id.camera,
          path,
        };
        this.identified.set(path, { listing, stamp });
        return { kind: 'camera', listing, stamp };
      }
      if (lower.endsWith('.xmp')) {
        const text = await readFile(path, 'utf8');
        // Develop presets and sidecars share the extension; only profile looks are of interest.
        if (!/PresetType\s*=\s*["']Look["']/.test(text)) return undefined;
        const cached = this.identified.get(path);
        if (cached?.stamp === stamp && this.look.has(path)) {
          return { kind: 'look', listing: cached.listing, stamp, data: this.look.get(path)! };
        }
        const data = parseLookXmp(text);
        const listing: ProfileListing = {
          id: path,
          name: data.name,
          kind: 'look',
          group: groupOfLook(data, path),
          camera: data.restriction,
          base: data.base,
          uuid: data.uuid,
          supportsAmount: data.supportsAmount,
          path,
        };
        this.look.set(path, data);
        this.identified.set(path, { listing, stamp });
        return { kind: 'look', listing, stamp, data };
      }
    } catch (error) {
      return { kind: 'problem', problem: { path, reason: describe(error) } };
    }
    return undefined;
  }

  /** The profiles that fit `camera`: its DCPs and the looks whose base profile exists for it. */
  async list(camera: CameraInfo | undefined): Promise<PhotoProfiles> {
    const { profiles } = await this.index();
    const mine = profiles.filter((p) => p.kind === 'camera' && cameraFits(p.camera, camera));
    const baseNames = new Set(mine.map((p) => p.name.toLowerCase()));
    const looks = profiles.filter(
      (p) =>
        p.kind === 'look' &&
        cameraFits(p.camera, camera) &&
        baseNames.has((p.base ?? '').toLowerCase()),
    );
    return {
      camera: [camera?.make, camera?.model].filter(Boolean).join(' '),
      profiles: [...mine, ...looks],
    };
  }

  /** The profile a sidecar names for a photo shot with `camera`, or the reason it cannot be used. */
  async resolve(
    request: ProfileRequest,
    camera: CameraInfo | undefined,
  ): Promise<ProfileResolution> {
    const wantsLook = request.lookName !== undefined || request.lookUuid !== undefined;
    if (!request.profile && !wantsLook) return { status: 'none' };
    const { profiles, folders } = await this.index();
    const who = [camera?.make, camera?.model].filter(Boolean).join(' ') || 'this camera';

    let look: ProfileListing | undefined;
    if (wantsLook) {
      look = profiles.find(
        (p) =>
          p.kind === 'look' &&
          (request.lookUuid ? p.uuid === request.lookUuid : true) &&
          (request.lookName ? p.name.toLowerCase() === request.lookName.toLowerCase() : true),
      );
      if (!look) {
        return {
          status: 'missing',
          reason: this.notFound(request.lookName ?? 'The look', folders),
        };
      }
    }
    const baseName = request.profile ?? look?.base;
    if (!baseName) return { status: 'none' };
    const base = profiles.find(
      (p) =>
        p.kind === 'camera' &&
        p.name.toLowerCase() === baseName.toLowerCase() &&
        cameraFits(p.camera, camera),
    );
    if (!base) {
      return {
        status: 'missing',
        reason:
          folders.length === 0
            ? `The "${baseName}" profile is not available: no profile folder is set up.`
            : `No "${baseName}" profile for ${who} in the profile folders.`,
      };
    }
    if (look && look.base?.toLowerCase() !== base.name.toLowerCase()) {
      return {
        status: 'missing',
        reason: `${look.name} is made for ${look.base}, not ${base.name}.`,
      };
    }
    if (look && !cameraFits(look.camera, camera)) {
      return { status: 'missing', reason: `${look.name} is made for ${look.camera}.` };
    }
    try {
      const cameraData = await this.loadCamera(base);
      const lookData = look ? await this.loadLook(look) : undefined;
      return {
        status: 'ok',
        profile: {
          camera: cameraData,
          ...(lookData ? { look: lookData } : {}),
          amount: request.lookAmount ?? 1,
        },
      };
    } catch (error) {
      return { status: 'missing', reason: `${(look ?? base).name}: ${describe(error)}` };
    }
  }

  private notFound(name: string, folders: readonly string[]): string {
    return folders.length === 0
      ? `"${name}" is not available: no profile folder is set up.`
      : `No "${name}" profile in the profile folders.`;
  }

  private async loadCamera(listing: ProfileListing): Promise<CameraProfileData> {
    const info = await stat(listing.path);
    const stamp = `${info.mtimeMs}:${info.size}`;
    const cached = this.camera.get(listing.path);
    if (cached?.stamp === stamp) return cached.data;
    const data = parseDcp(new Uint8Array(await readFile(listing.path)));
    this.camera.set(listing.path, { stamp, data });
    return data;
  }

  private async loadLook(listing: ProfileListing): Promise<LookProfileData> {
    const data = this.look.get(listing.path);
    if (!data) throw new IpcError('not_found', `${listing.name} is not loaded`);
    return data;
  }
}

function tryIdentify(
  bytes: Uint8Array,
  partial: boolean,
): { name: string; camera: string } | undefined {
  try {
    return identifyDcp(bytes, partial);
  } catch {
    return undefined;
  }
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function collect(folder: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const entries = await readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      await collect(path, depth + 1, out).catch((error: NodeJS.ErrnoException) => {
        // An unreadable subfolder must not hide the rest.
        if (error.code !== 'EACCES' && error.code !== 'EPERM' && error.code !== 'ENOENT')
          throw error;
      });
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if ((lower.endsWith('.dcp') || lower.endsWith('.xmp')) && !entry.name.startsWith('._')) {
        out.push(path);
      }
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof ProfileParseError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
