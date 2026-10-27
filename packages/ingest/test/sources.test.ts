import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asSourceId } from '@ee/contracts';
import type { CardSource, FolderSource } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestError } from '../src/errors';
import { findSidecar, listImageFiles, listSourceFiles } from '../src/sources';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

afterEach(cleanupTempDirs);

async function write(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'x');
}

describe('listImageFiles', () => {
  it('sorts by folder then natural file name and ignores temp files', async () => {
    const root = await makeTempDir();
    await write(join(root, '101NCZ', '_DSC1.NEF'));
    await write(join(root, '100NCZ', '_DSC10.NEF'));
    await write(join(root, '100NCZ', '_DSC9.NEF'));
    await write(join(root, '100NCZ', '.hidden.NEF'));
    await write(join(root, '100NCZ', '_DSC11.NEF.part'));
    await write(join(root, 'root.JPG'));

    const recursive = await listImageFiles(root, { recursive: true });
    expect(recursive.map((file) => `${file.relativeFolder}/${file.name}`)).toEqual([
      '/root.JPG',
      '100NCZ/_DSC9.NEF',
      '100NCZ/_DSC10.NEF',
      '101NCZ/_DSC1.NEF',
    ]);

    const flat = await listImageFiles(root);
    expect(flat.map((file) => file.name)).toEqual(['root.JPG']);
  });

  it('finds a sidecar for a raw, case-insensitively, but not for a JPEG', async () => {
    const root = await makeTempDir();
    await write(join(root, '_DSC9.NEF'));
    await write(join(root, '_DSC9.XMP'));
    await write(join(root, 'photo.JPG'));
    await write(join(root, 'photo.xmp'));

    const files = await listImageFiles(root);
    expect(files.map((file) => file.name)).toEqual(['_DSC9.NEF', 'photo.JPG']);
    const raw = files.find((file) => file.name === '_DSC9.NEF');
    const jpeg = files.find((file) => file.name === 'photo.JPG');
    expect(raw && (await findSidecar(raw))).toBe(join(root, '_DSC9.XMP'));
    expect(jpeg && (await findSidecar(jpeg))).toBeUndefined();
  });
});

describe('listSourceFiles', () => {
  it('walks every DCIM subfolder of a card', async () => {
    const mountPath = await makeTempDir();
    await write(join(mountPath, 'DCIM', '101NCZ', '_DSC2.NEF'));
    await write(join(mountPath, 'DCIM', '100NCZ', '_DSC10.NEF'));
    await write(join(mountPath, 'DCIM', '100NCZ', '_DSC9.NEF'));
    const source: CardSource = { kind: 'card', id: asSourceId('card'), name: 'Card', mountPath };

    const files = await listSourceFiles(source);
    expect(files.map((file) => file.name)).toEqual(['_DSC9.NEF', '_DSC10.NEF', '_DSC2.NEF']);
  });

  it('rejects a mount without DCIM', async () => {
    const mountPath = await makeTempDir();
    const source: CardSource = { kind: 'card', id: asSourceId('card'), name: 'Card', mountPath };
    await expect(listSourceFiles(source)).rejects.toBeInstanceOf(IngestError);
  });

  it('honours the recursive option for folder sources', async () => {
    const root = await makeTempDir();
    await write(join(root, 'nested', 'a.NEF'));
    const flat: FolderSource = {
      kind: 'folder',
      id: asSourceId('folder'),
      name: 'Folder',
      path: root,
    };
    expect(await listSourceFiles(flat)).toEqual([]);
    expect((await listSourceFiles({ ...flat, recursive: true })).map((file) => file.name)).toEqual([
      'a.NEF',
    ]);
  });
});
