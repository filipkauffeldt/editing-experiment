import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyPhotoLocal, nodeFileCopier, nodePlacementOperations } from '../src/copy';
import type { PlacementOperations } from '../src/copy';
import { VerificationError } from '../src/errors';
import { hashFile } from '../src/hash';
import type { FileCopier } from '../src/types';
import { delay } from './helpers/engine';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

afterEach(cleanupTempDirs);

async function setup(): Promise<{ source: string; destination: string; backup: string }> {
  const root = await makeTempDir();
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const backup = join(root, 'backup');
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(destination, { recursive: true }),
    mkdir(backup, { recursive: true }),
  ]);
  await writeFile(join(source, '_DSC9.NEF'), Buffer.from('raw-bytes'));
  await writeFile(join(source, '_DSC9.xmp'), '<xmp>caption</xmp>');
  return { source, destination, backup };
}

describe('copyPhotoLocal', () => {
  it('copies a raw and its sidecar with the same renamed base', async () => {
    const { source, destination } = await setup();

    const result = await copyPhotoLocal({
      sourcePath: join(source, '_DSC9.NEF'),
      sourceFileName: '_DSC9.NEF',
      sidecarSourcePath: join(source, '_DSC9.xmp'),
      finalBase: '2026-10-27_0001',
      primaryDirectory: destination,
    });

    expect(result.fileName).toBe('2026-10-27_0001.NEF');
    expect(result.sidecarPath).toBe(join(destination, '2026-10-27_0001.xmp'));
    expect(await readFile(result.path, 'utf8')).toBe('raw-bytes');
    expect(await readFile(result.sidecarPath ?? '', 'utf8')).toBe('<xmp>caption</xmp>');
    expect(result.sha256).toBe(await hashFile(join(source, '_DSC9.NEF')));
    expect((await readdir(destination)).sort()).toEqual([
      '2026-10-27_0001.NEF',
      '2026-10-27_0001.xmp',
    ]);
  });

  it('adds a numeric suffix instead of overwriting photos or sidecars', async () => {
    const { source, destination } = await setup();
    await writeFile(join(destination, 'shot.NEF'), 'existing raw');
    await writeFile(join(destination, 'shot.xmp'), 'existing sidecar');

    const result = await copyPhotoLocal({
      sourcePath: join(source, '_DSC9.NEF'),
      sourceFileName: '_DSC9.NEF',
      sidecarSourcePath: join(source, '_DSC9.xmp'),
      finalBase: 'shot',
      primaryDirectory: destination,
    });

    expect(result.fileName).toBe('shot_1.NEF');
    expect(result.sidecarPath).toBe(join(destination, 'shot_1.xmp'));
    expect(await readFile(join(destination, 'shot.NEF'), 'utf8')).toBe('existing raw');
    expect(await readFile(join(destination, 'shot.xmp'), 'utf8')).toBe('existing sidecar');
  });

  it('writes the primary and backup copies', async () => {
    const { source, destination, backup } = await setup();

    const result = await copyPhotoLocal({
      sourcePath: join(source, '_DSC9.NEF'),
      sourceFileName: '_DSC9.NEF',
      sidecarSourcePath: join(source, '_DSC9.xmp'),
      finalBase: 'shot',
      primaryDirectory: destination,
      backupDirectory: backup,
    });

    expect(await readFile(result.backupPath ?? '', 'utf8')).toBe('raw-bytes');
    expect(await readFile(result.backupSidecarPath ?? '', 'utf8')).toBe('<xmp>caption</xmp>');
  });

  it('fails and leaves no final file when the copy does not verify', async () => {
    const { source, destination } = await setup();
    const corrupting: FileCopier = {
      async copy(from, to) {
        await writeFile(to, 'corrupted');
        return {
          sourceHash: await hashFile(from),
          destinationHash: await hashFile(to),
        };
      },
    };

    await expect(
      copyPhotoLocal(
        {
          sourcePath: join(source, '_DSC9.NEF'),
          sourceFileName: '_DSC9.NEF',
          finalBase: 'shot',
          primaryDirectory: destination,
        },
        { copier: corrupting },
      ),
    ).rejects.toBeInstanceOf(VerificationError);

    expect(await readdir(destination)).toEqual([]);
  });

  it('removes the primary copy when the backup fails', async () => {
    const { source, destination, backup } = await setup();
    let calls = 0;
    const failingAfterFirst: FileCopier = {
      async copy(from, to, options) {
        calls += 1;
        if (calls > 1) {
          throw new Error('backup disk full');
        }
        return nodeFileCopier.copy(from, to, options);
      },
    };

    await expect(
      copyPhotoLocal(
        {
          sourcePath: join(source, '_DSC9.NEF'),
          sourceFileName: '_DSC9.NEF',
          finalBase: 'shot',
          primaryDirectory: destination,
          backupDirectory: backup,
        },
        { copier: failingAfterFirst },
      ),
    ).rejects.toThrow('backup disk full');

    expect(await readdir(destination)).toEqual([]);
  });
});

function withExdevLink(overrides: Partial<PlacementOperations> = {}): PlacementOperations {
  return {
    ...nodePlacementOperations,
    async link() {
      const error = new Error('cross-device link');
      (error as NodeJS.ErrnoException).code = 'EXDEV';
      throw error;
    },
    ...overrides,
  };
}

describe('copyPhotoLocal fallback placement', () => {
  it('renames the verified temp file when hard links are unavailable', async () => {
    const { source, destination } = await setup();

    const result = await copyPhotoLocal(
      {
        sourcePath: join(source, '_DSC9.NEF'),
        sourceFileName: '_DSC9.NEF',
        sidecarSourcePath: join(source, '_DSC9.xmp'),
        finalBase: 'shot',
        primaryDirectory: destination,
      },
      { placement: withExdevLink() },
    );

    expect(await readFile(result.path, 'utf8')).toBe('raw-bytes');
    expect(await readFile(result.sidecarPath ?? '', 'utf8')).toBe('<xmp>caption</xmp>');
    expect((await readdir(destination)).sort()).toEqual(['shot.NEF', 'shot.xmp']);
  });

  it('never exposes the final name while the fallback copy is in progress', async () => {
    const { source, destination } = await setup();
    const slowCopier: FileCopier = {
      async copy(from, to, options) {
        await delay(40);
        return nodeFileCopier.copy(from, to, options);
      },
    };

    const pending = copyPhotoLocal(
      {
        sourcePath: join(source, '_DSC9.NEF'),
        sourceFileName: '_DSC9.NEF',
        finalBase: 'shot',
        primaryDirectory: destination,
      },
      { copier: slowCopier, placement: withExdevLink() },
    );
    await delay(10);

    expect((await readdir(destination)).filter((name) => !name.endsWith('.ingest-tmp'))).toEqual(
      [],
    );
    await pending;
    expect(await readFile(join(destination, 'shot.NEF'), 'utf8')).toBe('raw-bytes');
  });

  it('removes the reserved name when publishing the fallback fails', async () => {
    const { source, destination } = await setup();
    const failingRename = withExdevLink({
      async rename() {
        const error = new Error('cannot publish');
        (error as NodeJS.ErrnoException).code = 'EIO';
        throw error;
      },
    });

    await expect(
      copyPhotoLocal(
        {
          sourcePath: join(source, '_DSC9.NEF'),
          sourceFileName: '_DSC9.NEF',
          finalBase: 'shot',
          primaryDirectory: destination,
        },
        { placement: failingRename },
      ),
    ).rejects.toThrow('cannot publish');

    expect(await readdir(destination)).toEqual([]);
  });
});
