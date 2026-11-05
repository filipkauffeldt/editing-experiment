// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultPresetFolders, PresetFolders } from '../src/jobs/backend/preset-folders';
import { PresetLibrary } from '../src/jobs/backend/preset-library';
import { PresetStore } from '../src/jobs/backend/presets';

/**
 * Preset discovery over real folders of synthetic files. Nothing here is an Adobe file: the presets
 * are written by the helpers below, in the shape Lightroom and Camera Raw write them.
 */

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-preset-folders-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map(async (dir) => {
      await chmod(dir, 0o755).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

interface XmpOptions {
  uuid: string;
  name: string;
  group?: string;
  type?: string;
  exposure?: number;
}

const xmpPreset = ({
  uuid,
  name,
  group,
  type = 'Normal',
  exposure = 0.5,
}: XmpOptions): string => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="${type}"
   crs:UUID="${uuid}"
   crs:Version="15.0"
   crs:ProcessVersion="15.4"
   crs:HasSettings="True"
   crs:Exposure2012="${exposure >= 0 ? '+' : ''}${exposure.toFixed(2)}"
   crs:Contrast2012="+10">
   <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">${name}</rdf:li></rdf:Alt></crs:Name>
   ${group ? `<crs:Group><rdf:Alt><rdf:li xml:lang="x-default">${group}</rdf:li></rdf:Alt></crs:Group>` : ''}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const lrtemplate = (uuid: string, name: string, exposure = 0.5): string => `s = {
	id = "${uuid}",
	internalName = "${name}",
	title = "${name}",
	type = "Develop",
	value = {
		settings = {
			Exposure2012 = ${exposure},
			Contrast2012 = 10,
		},
	},
	version = 0,
}
`;

const put = async (root: string, path: string, text: string): Promise<string> => {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
  return file;
};

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Everything about a tree that a write could change: names, bytes, modes and modified times. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (folder: string): Promise<void> => {
    const info = await stat(folder);
    out[`${relative(root, folder) || '.'}/`] = `${info.mode}:${info.mtimeMs}`;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const file = await stat(path);
        const hash = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
        out[relative(root, path)] = `${file.mode}:${file.mtimeMs}:${file.size}:${hash}`;
      }
    }
  };
  await walk(root);
  return out;
}

function folders(...roots: string[]): PresetFolders {
  return new PresetFolders({ folders: () => roots, platform: 'linux', env: {}, home: '/nobody' });
}

describe('default preset folders', () => {
  it('are Camera Raw Settings and Lightroom Develop Presets on macOS', () => {
    expect(defaultPresetFolders('darwin', {}, '/Users/anna')).toEqual([
      '/Users/anna/Library/Application Support/Adobe/CameraRaw/Settings',
      '/Users/anna/Library/Application Support/Adobe/Lightroom/Develop Presets',
    ]);
  });

  it('are below %APPDATA% on Windows, with Windows path rules on any host', () => {
    expect(
      defaultPresetFolders(
        'win32',
        { APPDATA: 'C:\\Users\\anna\\AppData\\Roaming' },
        'C:\\Users\\anna',
      ),
    ).toEqual([
      'C:\\Users\\anna\\AppData\\Roaming\\Adobe\\CameraRaw\\Settings',
      'C:\\Users\\anna\\AppData\\Roaming\\Adobe\\Lightroom\\Develop Presets',
    ]);
  });

  it('falls back to the home folder when %APPDATA% is not set', () => {
    expect(defaultPresetFolders('win32', {}, 'C:\\Users\\anna')[0]).toBe(
      'C:\\Users\\anna\\AppData\\Roaming\\Adobe\\CameraRaw\\Settings',
    );
  });

  it('are none on Linux, and the user’s folders come after Adobe’s without repeats', () => {
    expect(defaultPresetFolders('linux', {}, '/home/anna')).toEqual([]);
    const scanner = new PresetFolders({
      folders: () => ['/a', '/b', '/a'],
      platform: 'darwin',
      env: {},
      home: '/Users/anna',
    });
    expect(scanner.folders()).toEqual([
      '/Users/anna/Library/Application Support/Adobe/CameraRaw/Settings',
      '/Users/anna/Library/Application Support/Adobe/Lightroom/Develop Presets',
      '/a',
      '/b',
    ]);
  });
});

describe('PresetFolders', () => {
  it('finds .xmp and .lrtemplate presets below nested folders and groups them', async () => {
    const root = await tempDir();
    await put(root, 'Top.xmp', xmpPreset({ uuid: UUID(1), name: 'Top' }));
    await put(root, 'Sport/Fotboll/Kvall.xmp', xmpPreset({ uuid: UUID(2), name: 'Kväll' }));
    await put(root, 'Sport/Gammal.lrtemplate', lrtemplate(UUID(3), 'Gammal'));
    // The file names its own group: that is where Adobe lists it, whatever folder it sits in.
    await put(
      root,
      'Kopior/Namngiven.xmp',
      xmpPreset({ uuid: UUID(4), name: 'Namngiven', group: 'Creative' }),
    );

    const scan = await folders(root).scan();

    expect(scan.problems).toEqual([]);
    expect(scan.folders).toEqual([root]);
    const byName = Object.fromEntries(scan.found.map((f) => [f.stored.name, f.stored]));
    expect(byName['Top']?.group).toBeUndefined();
    expect(byName['Kväll']?.group).toBe('Sport/Fotboll');
    expect(byName['Gammal']?.group).toBe('Sport');
    expect(byName['Namngiven']?.group).toBe('Creative');
    expect(byName['Gammal']?.params.Exposure2012).toBe(0.5);
    expect(byName['Kväll']?.path).toBe(join(root, 'Sport', 'Fotboll', 'Kvall.xmp'));
  });

  it('leaves out Camera Raw looks and other preset types without calling them problems', async () => {
    const root = await tempDir();
    await put(root, 'Look.xmp', xmpPreset({ uuid: UUID(1), name: 'Vivid', type: 'Look' }));
    await put(root, 'Mask.xmp', xmpPreset({ uuid: UUID(2), name: 'Sky', type: 'Mask' }));
    await put(root, 'Real.xmp', xmpPreset({ uuid: UUID(3), name: 'Real' }));
    await put(root, 'readme.txt', 'not a preset');

    const scan = await folders(root).scan();

    expect(scan.found.map((f) => f.stored.name)).toEqual(['Real']);
    expect(scan.problems).toEqual([]);
  });

  it('carries the settings the app does not implement, so the UI can say so', async () => {
    const root = await tempDir();
    await put(
      root,
      'A.xmp',
      xmpPreset({ uuid: UUID(1), name: 'A' }).replace(
        'crs:Contrast2012="+10"',
        'crs:Contrast2012="+10" crs:MadeUpSetting="3"',
      ),
    );
    const scan = await folders(root).scan();
    expect(scan.found[0]?.stored.unsupported).toEqual(['MadeUpSetting']);
  });

  it('reports a file that cannot be parsed with its path and reason, and lists the rest', async () => {
    const root = await tempDir();
    const broken = await put(root, 'Sport/Trasig.xmp', '<x:xmpmeta><unclosed>');
    const notPreset = await put(root, 'Sport/Foto.xmp', '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    await put(root, 'Sport/Bra.xmp', xmpPreset({ uuid: UUID(1), name: 'Bra' }));

    const scan = await folders(root).scan();

    expect(scan.found.map((f) => f.stored.name)).toEqual(['Bra']);
    expect(scan.problems.map((p) => p.path).sort()).toEqual([broken, notPreset].sort());
    expect(scan.problems.every((p) => p.reason.length > 0)).toBe(true);
  });

  it('is fine with a folder that does not exist', async () => {
    const root = await tempDir();
    await put(root, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A' }));
    const scan = await folders(join(root, 'unplugged'), root).scan();
    expect(scan.found.map((f) => f.stored.name)).toEqual(['A']);
    expect(scan.problems).toEqual([]);
    expect(scan.folders).toEqual([root]);
  });

  it('reads a changed file again and forgets a removed one', async () => {
    const root = await tempDir();
    const file = await put(root, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A', exposure: 0.5 }));
    const gone = await put(root, 'B.xmp', xmpPreset({ uuid: UUID(2), name: 'B' }));
    const scanner = folders(root);
    const first = await scanner.scan();
    expect(first.found.find((f) => f.stored.name === 'A')?.stored.params.Exposure2012).toBe(0.5);

    await writeFile(file, xmpPreset({ uuid: UUID(1), name: 'A', exposure: -1 }));
    await rm(gone);
    const second = await scanner.scan();

    expect(second.found.map((f) => f.stored.name)).toEqual(['A']);
    expect(second.found[0]?.stored.params.Exposure2012).toBe(-1);
  });

  it('does not read a file again while its stamp is the same', async () => {
    const root = await tempDir();
    const file = await put(root, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A', exposure: 0.5 }));
    const longAgo = new Date(Date.now() - 3_600_000);
    await utimes(file, longAgo, longAgo);
    let reads = 0;
    const scanner = new PresetFolders({
      folders: () => [root],
      platform: 'linux',
      env: {},
      home: '/nobody',
      fs: {
        readdir,
        stat,
        readFile: ((...args: Parameters<typeof readFile>) => {
          reads += 1;
          return readFile(...args);
        }) as typeof readFile,
      },
    });
    await scanner.scan();
    await scanner.scan();
    expect(reads).toBe(1);
    // Same size, new time: a changed file even if it kept its length.
    await writeFile(file, xmpPreset({ uuid: UUID(1), name: 'A', exposure: 0.6 }));
    await utimes(file, new Date(), new Date(Date.now() - 1_800_000));
    await scanner.scan();
    expect(reads).toBe(2);
  });

  it('stops at the depth limit', async () => {
    const root = await tempDir();
    const deep = (levels: number): string => Array.from({ length: levels }, () => 'd').join('/');
    await put(root, `${deep(8)}/Inside.xmp`, xmpPreset({ uuid: UUID(1), name: 'Inside' }));
    await put(root, `${deep(9)}/Outside.xmp`, xmpPreset({ uuid: UUID(2), name: 'Outside' }));
    const scan = await folders(root).scan();
    expect(scan.found.map((f) => f.stored.name)).toEqual(['Inside']);
  });

  it('does not list a folder that never answers, keeps the others, and does not wait for it', async () => {
    const good = await tempDir();
    await put(good, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A' }));
    const dead = '/mnt/nas/presets';
    let deadCalls = 0;
    const scanner = new PresetFolders({
      folders: () => [dead, good],
      platform: 'linux',
      env: {},
      home: '/nobody',
      timeoutMs: 50,
      fs: {
        readFile,
        stat,
        readdir: ((path: string, ...rest: unknown[]) => {
          if (path === dead) {
            deadCalls += 1;
            return new Promise(() => undefined);
          }
          return (readdir as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
        }) as typeof readdir,
      },
    });

    const started = Date.now();
    const first = await scanner.scan();
    const second = await scanner.scan();

    expect(Date.now() - started).toBeLessThan(2000);
    expect(first.found.map((f) => f.stored.name)).toEqual(['A']);
    expect(first.problems).toHaveLength(1);
    expect(first.problems[0]).toMatchObject({ path: dead });
    expect(first.problems[0]?.reason).toMatch(/did not answer/);
    expect(second.problems).toHaveLength(1);
    // The call that never returned is joined by the second scan, not issued again.
    expect(deadCalls).toBe(1);
  });

  it('never writes: a scan leaves every byte, mode and modified time as it was', async () => {
    const root = await tempDir();
    await put(root, 'Sport/A.xmp', xmpPreset({ uuid: UUID(1), name: 'A' }));
    await put(root, 'Sport/B.lrtemplate', lrtemplate(UUID(2), 'B'));
    await put(root, 'Look.xmp', xmpPreset({ uuid: UUID(3), name: 'Vivid', type: 'Look' }));
    await put(root, 'Bad.xmp', 'nope');
    await utimes(join(root, 'Sport', 'A.xmp'), new Date(2020, 1, 1), new Date(2020, 1, 1));
    const before = await snapshot(root);

    const scanner = folders(root);
    await scanner.scan();
    await new PresetLibrary(new PresetStore(join(await tempDir(), 'presets')), scanner).resolve(
      UUID(1),
    );

    expect(await snapshot(root)).toEqual(before);
  });

  it('scans a folder it may only read', async () => {
    const root = await tempDir();
    await put(root, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A' }));
    await chmod(join(root, 'A.xmp'), 0o444);
    await chmod(root, 0o555);
    const scan = await folders(root).scan();
    expect(scan.found.map((f) => f.stored.name)).toEqual(['A']);
  });
});

describe('PresetLibrary', () => {
  async function setup() {
    const root = await tempDir();
    const presetFolder = join(root, 'Settings');
    await mkdir(presetFolder);
    const store = new PresetStore(join(root, 'userdata', 'presets'));
    const library = new PresetLibrary(store, folders(presetFolder));
    return { root, presetFolder, store, library };
  }

  it('lists a preset once when a .lrtemplate and an .xmp have the same id, and shows the .xmp', async () => {
    const { presetFolder, library } = await setup();
    await put(presetFolder, 'Old/Kvall.lrtemplate', lrtemplate(UUID(1), 'Kväll', 0.1));
    await put(
      presetFolder,
      'New/Kvall.xmp',
      xmpPreset({ uuid: UUID(1), name: 'Kväll', exposure: 0.9 }),
    );

    const { presets } = await library.index();

    expect(presets).toHaveLength(1);
    expect(presets[0]?.path.endsWith('Kvall.xmp')).toBe(true);
    expect(presets[0]?.params.Exposure2012).toBe(0.9);
  });

  it('compares ids without regard to case', async () => {
    const { presetFolder, library } = await setup();
    await put(
      presetFolder,
      'A.xmp',
      xmpPreset({ uuid: 'ABCDEF00-0000-4000-8000-000000000001', name: 'A' }),
    );
    await put(
      presetFolder,
      'B.lrtemplate',
      lrtemplate('abcdef00-0000-4000-8000-000000000001', 'A'),
    );
    expect((await library.index()).presets).toHaveLength(1);
  });

  it('lists an imported copy of a discovered preset once, the file winning, and brings the copy back when the file goes', async () => {
    const { presetFolder, store, library } = await setup();
    const file = await put(
      presetFolder,
      'Sport/A.xmp',
      xmpPreset({ uuid: UUID(1), name: 'A', exposure: 0.2 }),
    );
    await store.import(file);
    await writeFile(file, xmpPreset({ uuid: UUID(1), name: 'A', exposure: 0.8 }));

    const shown = (await library.index(true)).presets;
    expect(shown).toHaveLength(1);
    expect(shown[0]?.params.Exposure2012).toBe(0.8);
    expect(shown[0]?.group).toBe('Sport');

    await rm(file);
    const after = (await library.index(true)).presets;
    expect(after).toHaveLength(1);
    expect(after[0]?.params.Exposure2012).toBe(0.2);
  });

  it('lists two different presets with the same name', async () => {
    const { presetFolder, library } = await setup();
    await put(presetFolder, 'A/Punchy.xmp', xmpPreset({ uuid: UUID(1), name: 'Punchy' }));
    await put(presetFolder, 'B/Punchy.xmp', xmpPreset({ uuid: UUID(2), name: 'Punchy' }));
    const { presets } = await library.index();
    expect(presets.map((p) => [p.group, p.name])).toEqual([
      ['A', 'Punchy'],
      ['B', 'Punchy'],
    ]);
  });

  it('gives a preset without an id the same id each scan, and another to a file elsewhere', async () => {
    const { presetFolder, library } = await setup();
    const bare = (name: string): string =>
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.50" crs:Name="${name}"/></rdf:RDF></x:xmpmeta>`;
    await put(presetFolder, 'A.xmp', bare('A'));
    await put(presetFolder, 'B.xmp', bare('B'));
    const first = (await library.index(true)).presets.map((p) => p.id);
    const second = (await library.index(true)).presets.map((p) => p.id);
    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(2);
    expect(second).toEqual(first);
  });

  it('sorts ungrouped presets first, then by group and name', async () => {
    const { presetFolder, library } = await setup();
    await put(presetFolder, 'Z.xmp', xmpPreset({ uuid: UUID(1), name: 'Zebra' }));
    await put(presetFolder, 'B/A.xmp', xmpPreset({ uuid: UUID(2), name: 'Alfa' }));
    await put(presetFolder, 'A/C.xmp', xmpPreset({ uuid: UUID(3), name: 'Charlie' }));
    await put(presetFolder, 'A/B.xmp', xmpPreset({ uuid: UUID(4), name: 'Bravo' }));
    expect((await library.index()).presets.map((p) => p.name)).toEqual([
      'Zebra',
      'Bravo',
      'Charlie',
      'Alfa',
    ]);
  });

  it('scans again only when asked, or when the folders change', async () => {
    const root = await tempDir();
    const a = join(root, 'a');
    const b = join(root, 'b');
    await put(a, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A' }));
    await put(b, 'B.xmp', xmpPreset({ uuid: UUID(2), name: 'B' }));
    let chosen = [a];
    const library = new PresetLibrary(
      new PresetStore(join(root, 'presets')),
      new PresetFolders({ folders: () => chosen, platform: 'linux', env: {}, home: '/nobody' }),
    );
    expect((await library.index()).presets.map((p) => p.name)).toEqual(['A']);
    await put(a, 'Later.xmp', xmpPreset({ uuid: UUID(3), name: 'Later' }));
    // No timer and no watcher: the new file is not there until someone asks.
    expect((await library.index()).presets.map((p) => p.name)).toEqual(['A']);
    expect((await library.index(true)).presets.map((p) => p.name)).toEqual(['A', 'Later']);
    chosen = [a, b];
    expect((await library.index()).presets.map((p) => p.name)).toEqual(['A', 'B', 'Later']);
  });

  it('answers any number of overlapping rescans with one more scan that follows the running one', async () => {
    const { presetFolder, library } = await setup();
    await put(presetFolder, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A' }));
    await put(presetFolder, 'B.xmp', xmpPreset({ uuid: UUID(2), name: 'B' }));
    const first = library.index(true);
    const second = library.index(true);
    const third = library.index(true);
    expect(third).toBe(second);
    expect((await first).presets).toHaveLength(2);
    expect((await second).presets).toHaveLength(2);
  });

  describe('resolve', () => {
    it('finds a preset that was added since the last listing', async () => {
      const { presetFolder, library } = await setup();
      await library.index();
      await put(presetFolder, 'New.xmp', xmpPreset({ uuid: UUID(7), name: 'New' }));
      expect((await library.resolve(UUID(7)))?.name).toBe('New');
    });

    it('reads a changed file as it is now', async () => {
      const { presetFolder, library } = await setup();
      const file = await put(
        presetFolder,
        'A.xmp',
        xmpPreset({ uuid: UUID(1), name: 'A', exposure: 0.5 }),
      );
      expect((await library.resolve(UUID(1)))?.params.Exposure2012).toBe(0.5);
      await writeFile(file, xmpPreset({ uuid: UUID(1), name: 'A', exposure: 1.5 }));
      expect((await library.resolve(UUID(1)))?.params.Exposure2012).toBe(1.5);
    });

    it('is undefined once the file is gone', async () => {
      const { presetFolder, library } = await setup();
      const file = await put(presetFolder, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A' }));
      expect(await library.resolve(UUID(1))).toBeDefined();
      await rm(file);
      expect(await library.resolve(UUID(1))).toBeUndefined();
      expect(await library.resolve('never-existed')).toBeUndefined();
    });
  });

  it('keeps listing when a stored import cannot be read', async () => {
    const { presetFolder, root, library } = await setup();
    await put(presetFolder, 'A.xmp', xmpPreset({ uuid: UUID(1), name: 'A' }));
    const broken = await put(join(root, 'userdata'), 'presets/broken.json', '{ not json');
    const { presets, problems } = await library.index();
    expect(presets.map((p) => p.name)).toEqual(['A']);
    expect(problems.map((p) => p.path)).toEqual([broken]);
  });
});
