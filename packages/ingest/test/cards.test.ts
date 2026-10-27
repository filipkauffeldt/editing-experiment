import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectCards, type CardEntry, type CardFileSystem } from '../src/cards';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

class FakeCardFs implements CardFileSystem {
  readonly #directories = new Set<string>();
  readonly #entries = new Map<string, CardEntry[]>();

  addEntry(parent: string, name: string, isDirectory: boolean): void {
    const children = this.#entries.get(parent) ?? [];
    children.push({ name, isDirectory });
    this.#entries.set(parent, children);
    if (isDirectory) {
      this.#directories.add(posix.join(parent, name));
    }
  }

  addDirectory(path: string, parent: string, name: string): void {
    this.addEntry(parent, name, true);
    this.#directories.add(path);
  }

  addFile(path: string, parent: string, name: string): void {
    this.addEntry(parent, name, false);
    void path;
  }

  async list(path: string): Promise<CardEntry[]> {
    return this.#entries.get(path) ?? [];
  }

  async isDirectory(path: string): Promise<boolean> {
    return this.#directories.has(path);
  }
}

function addVolume(
  fs: FakeCardFs,
  join: (parent: string, name: string) => string,
  parent: string,
  volume: string,
  files: string[],
): string {
  const mount = join(parent, volume);
  const dcim = join(mount, 'DCIM');
  const folder = join(dcim, '100NCZ');
  fs.addDirectory(mount, parent, volume);
  fs.addDirectory(dcim, mount, 'DCIM');
  fs.addDirectory(folder, dcim, '100NCZ');
  for (const file of files) {
    fs.addFile(join(folder, file), folder, file);
  }
  return mount;
}

afterEach(cleanupTempDirs);

describe('detectCards', () => {
  it('finds a card on a real Linux mount root', async () => {
    const parent = await makeTempDir();
    const card = join(parent, 'NIKON_Z9');
    const folder = join(card, 'DCIM', '100NCZ');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '_DSC9.NEF'), 'raw');

    const cards = await detectCards({ platform: 'linux', mountRoots: [parent] });

    expect(cards).toEqual([{ mountPath: card, volumeLabel: 'NIKON_Z9', imageCount: 1 }]);
  });

  it('finds Linux volumes with a DCIM folder', async () => {
    const fs = new FakeCardFs();
    fs.addDirectory('/media/filip', '/', 'filip');
    fs.addDirectory('/run/media/filip', '/run/media', 'filip');
    const mount = addVolume(fs, posix.join, '/media/filip', 'NIKON_Z9', ['_DSC9.NEF']);
    fs.addDirectory('/run/media/filip/OTHER', '/run/media/filip', 'OTHER');

    const cards = await detectCards({
      platform: 'linux',
      user: 'filip',
      mountRoots: ['/media/filip', '/run/media/filip'],
      fs,
    });

    expect(cards).toEqual([{ mountPath: mount, volumeLabel: 'NIKON_Z9', imageCount: 1 }]);
  });

  it('finds macOS volumes under /Volumes', async () => {
    const fs = new FakeCardFs();
    fs.addDirectory('/Volumes', '/', 'Volumes');
    const mount = addVolume(fs, posix.join, '/Volumes', 'EOS_DIGITAL', ['a.CR3']);

    const cards = await detectCards({ platform: 'darwin', mountRoots: ['/Volumes'], fs });

    expect(cards).toEqual([{ mountPath: mount, volumeLabel: 'EOS_DIGITAL', imageCount: 1 }]);
  });

  it('probes Windows drive letters D: through Z:', async () => {
    const fs = new FakeCardFs();
    const dcim = win32.join('D:', 'DCIM');
    const folder = win32.join(dcim, '100NCZ');
    fs.addDirectory('D:\\', 'D:', '');
    fs.addDirectory(dcim, 'D:\\', 'DCIM');
    fs.addDirectory(folder, dcim, '100NCZ');
    fs.addFile(win32.join(folder, 'shot.NEF'), folder, 'shot.NEF');

    const cards = await detectCards({
      platform: 'win32',
      mountRoots: ['D:', 'E:'],
      fs,
    });

    expect(cards).toEqual([{ mountPath: 'D:\\', volumeLabel: 'D:', imageCount: 1 }]);
  });
});
