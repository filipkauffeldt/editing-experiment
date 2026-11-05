// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { JobsTrashRequestMessage } from '../src/shared/jobs-protocol';
import { TrashBridge, serveTrashRequest } from '../src/shared/trash-bridge';

describe('trash bridge between the jobs process and main', () => {
  it("resolves when main trashed the file and rejects with main's reason when it did not", async () => {
    const sent: JobsTrashRequestMessage[] = [];
    const bridge = new TrashBridge((message) => sent.push(message));

    const ok = bridge.trash('/ingest/a.jpg');
    const failed = bridge.trash('/ingest/b.jpg');
    expect(sent.map((message) => message.path)).toEqual(['/ingest/a.jpg', '/ingest/b.jpg']);
    // Answers may arrive in any order and are matched by id.
    bridge.handleResult({
      kind: 'trash-result',
      id: sent[1]!.id,
      error: 'no trash on this volume',
    });
    bridge.handleResult({ kind: 'trash-result', id: sent[0]!.id });

    await expect(ok).resolves.toBeUndefined();
    await expect(failed).rejects.toThrow('no trash on this volume');
  });

  it('rejects when main never answers, and ignores an answer that comes too late', async () => {
    vi.useFakeTimers();
    try {
      const sent: JobsTrashRequestMessage[] = [];
      const bridge = new TrashBridge((message) => sent.push(message), 1000);
      const pending = bridge.trash('/ingest/a.jpg');
      // Its own code, so the photo deleter does not retry a request that may still be running.
      const rejected = expect(pending).rejects.toMatchObject({
        message: expect.stringMatching(/did not answer/),
        code: 'ETIMEDOUT',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(() => bridge.handleResult({ kind: 'trash-result', id: sent[0]!.id })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves a request with the trash function and reports its failure as data', async () => {
    const trashed: string[] = [];
    expect(
      await serveTrashRequest(
        { kind: 'trash-request', id: 7, path: '/ingest/a.jpg' },
        async (p) => {
          trashed.push(p);
        },
      ),
    ).toEqual({ kind: 'trash-result', id: 7 });
    expect(trashed).toEqual(['/ingest/a.jpg']);

    expect(
      await serveTrashRequest({ kind: 'trash-request', id: 8, path: '/ingest/b.jpg' }, async () => {
        throw new Error('Failed to move to trash');
      }),
    ).toEqual({ kind: 'trash-result', id: 8, error: 'Failed to move to trash' });
  });

  it('refuses a relative path without calling the trash', async () => {
    const trash = vi.fn(async () => {});
    const reply = await serveTrashRequest({ kind: 'trash-request', id: 1, path: 'a.jpg' }, trash);
    expect(reply.error).toMatch(/absolute/);
    expect(trash).not.toHaveBeenCalled();
  });
});

describe('main trash function', () => {
  it('uses the system trash unless a test folder is set, and then only moves the file there', async () => {
    const { mkdtemp, readdir, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createTrashItem } = await import('../src/main/trash');

    const system = vi.fn(async () => {});
    await createTrashItem(system, {})('/a.jpg');
    expect(system).toHaveBeenCalledWith('/a.jpg');

    const root = await mkdtemp(join(tmpdir(), 'ee-trash-'));
    try {
      await writeFile(join(root, 'photo.jpg'), 'pixels');
      const trashItem = createTrashItem(system, { EE_TRASH_DIR: join(root, 'trash') });
      await trashItem(join(root, 'photo.jpg'));
      expect(system).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual(['trash']);
      const [moved] = await readdir(join(root, 'trash'));
      expect(moved).toMatch(/photo\.jpg$/);
      expect(await readFile(join(root, 'trash', moved!), 'utf8')).toBe('pixels');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
