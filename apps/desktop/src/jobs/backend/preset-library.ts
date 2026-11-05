import type { PresetIndex, PresetProblem } from '@ee/contracts';
import type { PresetFolders } from './preset-folders';
import type { PresetStore, StoredPreset } from './presets';

/**
 * Every develop preset the app offers: the ones found in the preset folders (read where they are) and
 * the ones imported by hand (a copy under userData), one entry each.
 *
 * **Identity.** A preset's id is the UUID its file carries (`crs:UUID`, or `id` in a `.lrtemplate`),
 * else a hash of the file's path; ids are compared without regard to case. Two files with the same
 * id are the same preset and appear once. Which one is shown: a file found in a folder wins over an
 * imported copy (the file is the newer truth, and the copy shows again if the file goes), `.xmp`
 * wins over `.lrtemplate`, and then the earlier folder and path. Presets with the same name and
 * different ids all appear.
 */
export class PresetLibrary {
  private foldersKey = '';
  private running: Promise<PresetIndex> | undefined;
  /** A scan asked for while another ran; one is enough for any number of askers. */
  private queued: Promise<PresetIndex> | undefined;
  private latest: Promise<PresetIndex> | undefined;

  constructor(
    private readonly store: PresetStore,
    private readonly folders: PresetFolders,
  ) {}

  /** The presets: the last scan, or a new one when `rescan` or when the folders have changed. */
  index(rescan = false): Promise<PresetIndex> {
    const key = this.folders.folders().join('\n');
    if (key !== this.foldersKey) {
      this.foldersKey = key;
      rescan = true;
    }
    if (!rescan && this.latest) return this.latest;
    if (!this.running) return this.begin();
    // A scan that began before this call may have missed what changed, so one more follows it.
    this.queued ??= this.running.then(() => {
      this.queued = undefined;
      return this.begin();
    });
    this.latest = this.queued;
    return this.queued;
  }

  private begin(): Promise<PresetIndex> {
    const run = this.scan().finally(() => {
      if (this.running === run) this.running = undefined;
    });
    this.running = run;
    this.latest = run;
    return run;
  }

  /**
   * The preset with `id` as its file is now. A scan is made first, so an id that was saved some time
   * ago is looked up in what is on disk at this moment, not in what was listed earlier. `undefined`
   * when no file and no imported copy has it (deleted, or on a drive that does not answer).
   */
  async resolve(id: string): Promise<StoredPreset | undefined> {
    const wanted = identity(id);
    return (await this.index(true)).presets.find((preset) => identity(preset.id) === wanted);
  }

  private async scan(): Promise<PresetIndex> {
    const [scan, imported] = await Promise.all([
      this.folders.scan(),
      this.store.read().catch((error: unknown) => ({
        presets: [] as StoredPreset[],
        problems: [
          {
            path: 'imported presets',
            reason: error instanceof Error ? error.message : String(error),
          },
        ] as PresetProblem[],
      })),
    ]);
    // Best first: the first entry of an id is the one that is shown.
    const candidates = [
      ...scan.found.map((entry) => ({
        preset: entry.stored,
        rank: entry.format === 'xmp' ? 0 : 1,
      })),
      ...imported.presets.map((preset) => ({ preset, rank: 2 })),
    ];
    candidates.sort((a, b) => a.rank - b.rank); // stable: folder and path order within a rank
    const shown = new Map<string, StoredPreset>();
    for (const { preset } of candidates) {
      if (!shown.has(identity(preset.id))) shown.set(identity(preset.id), preset);
    }
    const presets = [...shown.values()].sort(
      (a, b) =>
        (a.group ?? '').localeCompare(b.group ?? '') ||
        a.name.localeCompare(b.name) ||
        a.path.localeCompare(b.path),
    );
    return {
      presets,
      problems: [...scan.problems, ...imported.problems],
      folders: scan.folders,
    };
  }
}

const identity = (id: string): string => id.toLowerCase();
