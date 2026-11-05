// @vitest-environment node
import {
  asVersionId,
  retouchOpsKey,
  type MosaicOp,
  type Photo,
  type PhotoId,
  type Rect,
  type RetouchVersion,
} from '@ee/contracts';
import { ExifToolService, readRetouchVersions, writeRetouchVersions } from '@ee/metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { activePhoto, createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

/**
 * The retouch store against a real sidecar: versions are written and read with ExifTool into the
 * XMP of a real JPEG, the way the jobs process does, so what comes back after an exit is exactly
 * what a restart would show.
 */

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });

describe('retouch commit, exit, resume and edit again (real sidecar)', () => {
  const exiftool = new ExifToolService();
  let root: string;
  let file: string;
  const stores: AppStore[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-retouch-roundtrip-'));
    file = join(root, 'frame.jpg');
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 120, b: 150 } },
    })
      .jpeg()
      .toFile(file);
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.dispose();
  });
  afterAll(async () => {
    await exiftool.close();
    await rm(root, { recursive: true, force: true });
  });

  async function openStore(initial: RetouchVersion[] = []): Promise<{
    store: AppStore;
    photo: Photo;
    stored: () => Promise<RetouchVersion[]>;
  }> {
    await writeRetouchVersions(file, initial, { service: exiftool });
    const fake = createFakeBridge();
    const base = await fake.bridge.invoke('photos:list');
    const id = base[0]!.id;
    const withSidecar = async (photoId: PhotoId): Promise<Photo> => {
      const photo = await fake.bridge.invoke('photos:get', { photoId });
      const retouch = await readRetouchVersions(file, exiftool);
      return {
        ...photo,
        width: 6000,
        height: 4000,
        versions: [...photo.versions.filter((v) => v.kind !== 'retouch'), ...retouch],
      };
    };
    const bridge = {
      ...fake.bridge,
      invoke: (async (channel: string, args: Record<string, unknown>) => {
        if (channel === 'photos:get') return withSidecar(args.photoId as PhotoId);
        if (channel === 'photos:list') {
          const all = await fake.bridge.invoke('photos:list');
          return [await withSidecar(all[0]!.id), ...all.slice(1)];
        }
        if (channel === 'photos:createVersion') {
          const versions = await readRetouchVersions(file, exiftool);
          const created: RetouchVersion = {
            id: asVersionId(`${id}:retouch:${versions.length + 1}`),
            kind: 'retouch',
            ops: [],
          };
          await writeRetouchVersions(file, [...versions, created], { service: exiftool });
          return created;
        }
        if (channel === 'retouch:set') {
          const versions = await readRetouchVersions(file, exiftool);
          await writeRetouchVersions(
            file,
            versions.map((v) =>
              v.id === args.versionId ? { ...v, ops: args.ops as RetouchVersion['ops'] } : v,
            ),
            { service: exiftool },
          );
          return undefined;
        }
        return (fake.bridge.invoke as (c: string, a?: unknown) => Promise<unknown>)(channel, args);
      }) as typeof fake.bridge.invoke,
    };
    const store = createAppStore(bridge);
    stores.push(store);
    await store.init();
    const photo = activePhoto(store.getState())!;
    expect(photo.id).toBe(id);
    return { store, photo, stored: () => readRetouchVersions(file, exiftool) };
  }

  it('resumes with the faces, their switches, the modes and the order, and saves the edit', async () => {
    const { store, stored } = await openStore();
    store.toggleRetouch();
    expect(store.getState().retouch).toMatchObject({
      tool: 'faces',
      mode: 'add',
    });

    store.addRetouchShape(rect(0.05, 0.05, 0.9, 0.9));
    store.addRetouchFaces([
      { box: rect(0.2, 0.2, 0.1, 0.12), score: 0.93 },
      { box: rect(0.6, 0.3, 0.1, 0.12), score: 0.88 },
    ]);
    store.setRetouchMode('subtract');
    store.addRetouchShape({
      type: 'polygon',
      points: [
        { x: 0.4, y: 0.5 },
        { x: 0.6, y: 0.5 },
        { x: 0.5, y: 0.7 },
      ],
    });
    store.toggleRetouchArea(2); // the second face goes off
    store.setRetouchFacePadding(0.3);
    store.setRetouchBlockSize(0.02);
    await store.commitRetouch();
    expect(store.getState().retouch).toBeUndefined();

    // On disk, in the sidecar JSON.
    const [version] = await stored();
    const op = version!.ops[0] as MosaicOp;
    expect(op.blockSizeRel).toBe(0.02);
    expect(op.facePadding).toBe(0.3);
    expect(
      op.areas?.map((a) => [a.face ? 'face' : a.shape.type, a.mode ?? 'add', a.enabled ?? true]),
    ).toEqual([
      ['rect', 'add', true],
      ['face', 'add', true],
      ['face', 'add', false],
      ['polygon', 'subtract', true],
    ]);
    const savedKey = retouchOpsKey(version!.ops);

    // Back into retouch mode: everything is editable again, and the defaults are the defaults.
    store.toggleRetouch();
    const session = store.getState().retouch!;
    expect(session).toMatchObject({
      tool: 'faces',
      mode: 'add',
      facePadding: 0.3,
      blockSizeRel: 0.02,
      dirty: false,
    });
    expect(session.areas.map((a) => [a.kind, a.mode, a.enabled])).toEqual([
      ['rect', 'add', true],
      ['face', 'add', true],
      ['face', 'add', false],
      ['lasso', 'subtract', true],
    ]);
    expect(session.areas[2]!.face).toEqual({ box: rect(0.6, 0.3, 0.1, 0.12), score: 0.88 });

    // Switch the face back on, draw one more area additively, and save.
    store.toggleRetouchArea(2);
    store.addRetouchShape(rect(0.8, 0.8, 0.1, 0.1));
    await store.commitRetouch();
    const [next] = await stored();
    const nextOp = next!.ops[0] as MosaicOp;
    expect(nextOp.areas).toHaveLength(5);
    expect(nextOp.areas?.[2]?.enabled).toBeUndefined();
    expect(nextOp.areas?.[0]).toEqual(op.areas?.[0]);
    expect(retouchOpsKey(next!.ops)).not.toBe(savedKey);
    // Still one version: the edit rewrote it.
    expect(await stored()).toHaveLength(1);
  });

  it('undo steps back through a drawing, a detection and a switch', async () => {
    const { store } = await openStore();
    store.toggleRetouch();
    store.addRetouchShape(rect(0.1, 0.1, 0.3, 0.3));
    store.addRetouchFaces([{ box: rect(0.5, 0.5, 0.1, 0.1) }]);
    store.toggleRetouchArea(1);
    store.setRetouchMode('subtract');
    store.addRetouchShape(rect(0.15, 0.15, 0.1, 0.1));
    expect(store.getState().retouch!.areas).toHaveLength(3);

    store.undoRetouchShape();
    expect(store.getState().retouch!.areas.map((a) => a.mode)).toEqual(['add', 'add']);
    store.undoRetouchShape();
    expect(store.getState().retouch!.areas[1]!.enabled).toBe(true);
    store.undoRetouchShape();
    expect(store.getState().retouch!.areas.map((a) => a.kind)).toEqual(['rect']);
    store.undoRetouchShape();
    expect(store.getState().retouch!.areas).toEqual([]);
    store.undoRetouchShape();
    expect(store.getState().retouch!.areas).toEqual([]);
  });

  it('resumes a version saved before areas existed, wand outline and all, as editable shapes', async () => {
    const legacy: RetouchVersion = {
      id: asVersionId('legacy:1'),
      kind: 'retouch',
      ops: [
        {
          type: 'mosaic',
          blockSizeRel: 0.012,
          shapes: [
            rect(0.1, 0.1, 0.2, 0.2),
            {
              type: 'polygon',
              points: [
                { x: 0.5, y: 0.5 },
                { x: 0.7, y: 0.5 },
                { x: 0.6, y: 0.7 },
              ],
            },
          ],
        },
      ],
    };
    const { store, stored } = await openStore([legacy]);
    store.toggleRetouch();
    const session = store.getState().retouch!;
    expect(session.versionId).toBe(legacy.id);
    expect(session.areas.map((a) => [a.kind, a.mode, a.enabled])).toEqual([
      ['rect', 'add', true],
      ['lasso', 'add', true],
    ]);

    // Both can be switched off, and the version is rewritten with areas, keeping its id.
    store.toggleRetouchArea(1);
    await store.commitRetouch();
    const [saved] = await stored();
    expect(saved!.id).toBe(legacy.id);
    const op = saved!.ops[0] as MosaicOp;
    expect(op.areas?.map((a) => a.enabled ?? true)).toEqual([true, false]);
    expect(op.shapes).toEqual([rect(0.1, 0.1, 0.2, 0.2)]);
  });
});
