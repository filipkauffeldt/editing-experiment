import { IpcError, type EditPreset } from '@ee/contracts';
import { parsePreset } from '@ee/develop-gl/preset';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-json';

/** An imported preset plus what the file set that this app does not implement. */
export type StoredPreset = EditPreset & { unsupported?: string[] };

/** Imported Lightroom/Camera Raw presets, one JSON file each under userData. */
export class PresetStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<StoredPreset[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const presets = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(
          async (name) => JSON.parse(await readFile(join(this.dir, name), 'utf8')) as StoredPreset,
        ),
    );
    return presets.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Parse a preset file and remember it. Importing the same preset again replaces it. */
  async import(path: string): Promise<StoredPreset> {
    const text = await readFile(path, 'utf8');
    const { preset, unsupported } = parsePreset(text, { path });
    if (typeof preset.id !== 'string' || preset.id === '') {
      throw new IpcError('invalid_argument', `preset ${path} has no id`);
    }
    const stored: StoredPreset = { ...preset, unsupported };
    await mkdir(this.dir, { recursive: true });
    const name = createHash('sha256').update(preset.id).digest('hex').slice(0, 24);
    writeJsonAtomic(join(this.dir, `${name}.json`), stored);
    return stored;
  }
}
