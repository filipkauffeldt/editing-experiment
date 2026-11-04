import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CardScanner, detectCards, type CardEntry, type CardFileSystem } from '../src/cards';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

type PathJoin = (parent: string, name: string) => string;

class FakeCardFs implements CardFileSystem {
  readonly directories = new Set<string>();
  readonly entries = new Map<string, CardEntry[]>();
  /** Paths whose calls never settle until `release` runs, like a dead network drive. */
  readonly hanging = new Map<string, () => void>();
  readonly calls: string[] = [];

  constructor(private readonly pathJoin: PathJoin = posix.join) {}

  addDirectory(parent: string, name: string, extra: Partial<CardEntry> = {}): string {
    const path = this.pathJoin(parent, name);
    const children = this.entries.get(parent) ?? [];
    children.push({ name, isDirectory: true, ...extra });
    this.entries.set(parent, children);
    if (!extra.isSymlink) {
      this.directories.add(path);
    }
    return path;
  }

  addFile(parent: string, name: string): void {
    const children = this.entries.get(parent) ?? [];
    children.push({ name, isDirectory: false });
    this.entries.set(parent, children);
  }

  /** A volume with `DCIM/100NCZ/<files>`. `parent` is a root folder (Linux/macOS) or empty. */
  addCard(parent: string, name: string, files: string[]): string {
    const mount = parent === '' ? name : this.addDirectory(parent, name);
    this.directories.add(mount);
    const dcim = this.addDirectory(mount, 'DCIM');
    const folder = this.addDirectory(dcim, '100NCZ');
    for (const file of files) {
      this.addFile(folder, file);
    }
    return mount;
  }

  hang(path: string): void {
    this.hanging.set(path, () => undefined);
  }

  private async maybeHang(path: string): Promise<void> {
    this.calls.push(path);
    if (this.hanging.has(path)) {
      await new Promise<void>(() => undefined);
    }
  }

  async list(path: string): Promise<CardEntry[]> {
    await this.maybeHang(path);
    return this.entries.get(path) ?? [];
  }

  async isDirectory(path: string): Promise<boolean> {
    await this.maybeHang(path);
    return this.directories.has(path);
  }
}

afterEach(cleanupTempDirs);

describe('detectCards on a real filesystem', () => {
  it('finds a card under a mount root and counts its images', async () => {
    const parent = await makeTempDir();
    const card = join(parent, 'NIKON_Z9');
    const folder = join(card, 'DCIM', '100NCZ');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '_DSC9.NEF'), 'raw');
    await writeFile(join(folder, 'notes.txt'), 'x');
    await mkdir(join(parent, 'plain-usb'));

    const cards = await detectCards({ platform: 'linux', mountRoots: [parent] });

    expect(cards).toEqual([{ mountPath: card, volumeLabel: 'NIKON_Z9', imageCount: 1 }]);
  });

  it('treats a missing mount root as no cards', async () => {
    const parent = await makeTempDir();
    expect(await detectCards({ platform: 'linux', mountRoots: [join(parent, 'absent')] })).toEqual(
      [],
    );
  });
});

describe('Linux', () => {
  it('scans /media/<user>, /run/media/<user> (Fedora) and /media directly', async () => {
    const fs = new FakeCardFs();
    const ubuntu = fs.addCard('/media/filip', 'NIKON_Z9', ['a.NEF']);
    const fedora = fs.addCard('/run/media/filip', 'EOS_DIGITAL', ['b.CR3', 'c.CR3']);
    const direct = fs.addCard('/media', 'SONY', ['d.ARW']);
    fs.addDirectory('/media', 'filip');
    fs.addDirectory('/media/filip', 'plain-usb');

    const cards = await detectCards({ platform: 'linux', user: 'filip', fs });

    expect(cards).toEqual([
      { mountPath: ubuntu, volumeLabel: 'NIKON_Z9', imageCount: 1 },
      { mountPath: direct, volumeLabel: 'SONY', imageCount: 1 },
      { mountPath: fedora, volumeLabel: 'EOS_DIGITAL', imageCount: 2 },
    ]);
  });

  it('keeps two cards that share a label apart by mount path', async () => {
    const fs = new FakeCardFs();
    const first = fs.addCard('/media/filip', 'NIKON Z 6', ['a.NEF']);
    const second = fs.addCard('/media/filip', 'NIKON Z 61', ['b.NEF', 'c.NEF']);
    fs.addCard('/run/media/filip', 'NIKON Z 6', ['d.NEF']);

    const cards = await detectCards({ platform: 'linux', user: 'filip', fs });

    expect(cards.map((card) => card.mountPath)).toEqual([
      '/media/filip/NIKON Z 6',
      '/media/filip/NIKON Z 61',
      '/run/media/filip/NIKON Z 6',
    ]);
    expect(new Set(cards.map((card) => card.mountPath)).size).toBe(3);
    expect(cards[0]).toMatchObject({ mountPath: first, volumeLabel: 'NIKON Z 6', imageCount: 1 });
    expect(cards[1]).toMatchObject({ mountPath: second, imageCount: 2 });
  });

  it('skips a root that is a hung mount and still reports the other cards', async () => {
    const fs = new FakeCardFs();
    const card = fs.addCard('/run/media/filip', 'NIKON_Z9', ['a.NEF']);
    fs.hang('/media/filip');

    const started = Date.now();
    const cards = await detectCards({
      platform: 'linux',
      user: 'filip',
      fs,
      probeTimeoutMs: 30,
    });

    expect(cards.map((entry) => entry.mountPath)).toEqual([card]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('macOS', () => {
  it('lists /Volumes cards and ignores the boot volume symlink', async () => {
    const fs = new FakeCardFs();
    const card = fs.addCard('/Volumes', 'EOS_DIGITAL', ['a.CR3']);
    fs.addDirectory('/Volumes', 'Macintosh HD', { isSymlink: true });
    // Even if something followed the link, `/` has no DCIM and must not be probed as a volume.
    fs.addDirectory('/Volumes', 'Macintosh HD - Data');

    const cards = await detectCards({ platform: 'darwin', fs });

    expect(cards).toEqual([{ mountPath: card, volumeLabel: 'EOS_DIGITAL', imageCount: 1 }]);
    expect(fs.calls).not.toContain('/Volumes/Macintosh HD/DCIM');
  });

  it('does not use the Linux roots', async () => {
    const fs = new FakeCardFs();
    fs.addCard('/media/filip', 'NIKON_Z9', ['a.NEF']);

    expect(await detectCards({ platform: 'darwin', user: 'filip', fs })).toEqual([]);
  });
});

describe('Windows', () => {
  const winFs = () => new FakeCardFs(win32.join);

  it('probes D: through Z: and reports drives with a DCIM folder', async () => {
    const fs = winFs();
    fs.addCard('', 'E:\\', ['shot.NEF', 'shot2.NEF']);
    fs.directories.add('D:\\');

    const cards = await detectCards({ platform: 'win32', fs });

    expect(cards).toEqual([{ mountPath: 'E:\\', volumeLabel: 'Drive E', imageCount: 2 }]);
    expect(fs.calls).toContain(win32.join('D:\\', 'DCIM'));
    expect(fs.calls).toContain(win32.join('Z:\\', 'DCIM'));
    expect(fs.calls.some((call) => call.startsWith('C:'))).toBe(false);
  });

  it('is not held up by a dead network drive and probes the drives concurrently', async () => {
    const fs = winFs();
    fs.addCard('', 'F:\\', ['a.NEF']);
    fs.hang(win32.join('D:\\', 'DCIM'));
    fs.hang(win32.join('E:\\', 'DCIM'));

    const started = Date.now();
    const cards = await detectCards({ platform: 'win32', fs, probeTimeoutMs: 40 });
    const elapsed = Date.now() - started;

    expect(cards.map((card) => card.mountPath)).toEqual(['F:\\']);
    // Two hung drives cost one timeout, not two: the probes ran concurrently.
    expect(elapsed).toBeLessThan(400);
  });

  it('does not probe a hung drive again while its first probe is still pending', async () => {
    const fs = winFs();
    fs.hang(win32.join('D:\\', 'DCIM'));
    const scanner = new CardScanner({
      platform: 'win32',
      fs,
      windowsDrives: ['D:'],
      probeTimeoutMs: 20,
    });

    await scanner.scan();
    await scanner.scan();
    await scanner.scan();

    expect(fs.calls.filter((call) => call === win32.join('D:\\', 'DCIM'))).toHaveLength(1);
  });

  it('accepts a custom mount root on any platform', async () => {
    const fs = winFs();
    const mount = fs.addCard('X:\\cards', 'CARD', ['a.NEF']);

    const cards = await detectCards({ platform: 'win32', mountRoots: ['X:\\cards'], fs });

    expect(cards).toEqual([{ mountPath: mount, volumeLabel: 'CARD', imageCount: 1 }]);
  });
});

describe('CardScanner', () => {
  it('returns a new card at once and fills in the count later, without recounting', async () => {
    const fs = new FakeCardFs();
    const card = fs.addCard('/media/filip', 'NIKON_Z9', ['a.NEF', 'b.NEF']);
    const folder = '/media/filip/NIKON_Z9/DCIM/100NCZ';
    fs.hang(folder);
    const scanner = new CardScanner({ platform: 'linux', user: 'filip', fs });

    // The count is stuck on the hung folder, but the card is listed immediately.
    expect(await scanner.scan()).toEqual([{ mountPath: card, volumeLabel: 'NIKON_Z9' }]);
    expect(await scanner.scan()).toEqual([{ mountPath: card, volumeLabel: 'NIKON_Z9' }]);
    expect(fs.calls.filter((call) => call === folder)).toHaveLength(1);

    fs.hanging.delete(folder);
    const done = new CardScanner({ platform: 'linux', user: 'filip', fs });
    expect(await done.scan({ waitForCounts: true })).toEqual([
      { mountPath: card, volumeLabel: 'NIKON_Z9', imageCount: 2 },
    ]);
    const before = fs.calls.length;
    await done.scan();
    await done.scan();
    // Later polls list the roots and probe DCIM but never walk the card again.
    expect(fs.calls.slice(before).filter((call) => call.includes('100NCZ'))).toEqual([]);
  });

  it('drops a card that was removed and counts it again when it returns', async () => {
    const fs = new FakeCardFs();
    const card = fs.addCard('/media/filip', 'NIKON_Z9', ['a.NEF']);
    const scanner = new CardScanner({ platform: 'linux', user: 'filip', fs });
    expect(await scanner.scan({ waitForCounts: true })).toHaveLength(1);

    fs.directories.delete(`${card}/DCIM`);
    expect(await scanner.scan()).toEqual([]);

    fs.directories.add(`${card}/DCIM`);
    fs.addFile('/media/filip/NIKON_Z9/DCIM/100NCZ', 'b.NEF');
    expect(await scanner.scan({ waitForCounts: true })).toEqual([
      { mountPath: card, volumeLabel: 'NIKON_Z9', imageCount: 2 },
    ]);
  });

  it('leaves the count out when counting fails', async () => {
    const fs = new FakeCardFs();
    const card = fs.addCard('/media/filip', 'NIKON_Z9', ['a.NEF']);
    const list = fs.list.bind(fs);
    fs.list = async (path) => {
      if (path.endsWith('DCIM')) throw new Error('EIO');
      return list(path);
    };

    const cards = await new CardScanner({ platform: 'linux', user: 'filip', fs }).scan({
      waitForCounts: true,
    });

    expect(cards).toEqual([{ mountPath: card, volumeLabel: 'NIKON_Z9' }]);
  });
});
