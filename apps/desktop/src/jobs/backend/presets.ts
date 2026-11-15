import { IpcError, type EditPreset, type PresetProblem } from '@ee/contracts';
import { parsePreset } from '@ee/develop-gl/preset';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-json';

/** An imported preset plus what the file set that this app does not implement. */
export type StoredPreset = EditPreset & { unsupported?: string[] };

/** The names {@link PresetStore.import} writes; anything else is a sync tool's file. */
const PRESET_FILE = /^[0-9a-f]{24}\.json$/;

/** Imported Lightroom/Camera Raw presets, one JSON file each under the settings folder. */
export class PresetStore {
  constructor(private readonly dir: string | (() => string)) {}

  private directory(): string {
    return typeof this.dir === 'function' ? this.dir() : this.dir;
  }

  async list(): Promise<StoredPreset[]> {
    return (await this.read()).presets;
  }

  /** The imported presets; a stored file that cannot be read is a problem, not a failure of the list. */
  async read(): Promise<{ presets: StoredPreset[]; problems: PresetProblem[] }> {
    const dir = this.directory();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { presets: [], problems: [] };
      throw error;
    }
    const presets: StoredPreset[] = [];
    const problems: PresetProblem[] = [];
    await Promise.all(
      names
        // Only this app's files: sync tools leave their own copies and temp files here.
        .filter((name) => PRESET_FILE.test(name))
        .map(async (name) => {
          const file = join(dir, name);
          try {
            presets.push(JSON.parse(await readFile(file, 'utf8')) as StoredPreset);
          } catch (error) {
            problems.push({
              path: file,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }),
    );
    return { presets: presets.sort((a, b) => a.name.localeCompare(b.name)), problems };
  }

  /** Parse a preset file and remember it. Importing the same preset again replaces it. */
  async import(path: string): Promise<StoredPreset> {
    const text = await readFile(path, 'utf8');
    const { preset, unsupported } = parsePreset(text, { path });
    if (typeof preset.id !== 'string' || preset.id === '') {
      throw new IpcError('invalid_argument', `preset ${path} has no id`);
    }
    const stored: StoredPreset = { ...preset, unsupported };
    const dir = this.directory();
    await mkdir(dir, { recursive: true });
    const name = createHash('sha256').update(preset.id).digest('hex').slice(0, 24);
    writeJsonAtomic(join(dir, `${name}.json`), stored);
    return stored;
  }
}
