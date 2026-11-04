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
      const rejected = expect(pending).rejects.toThrow(/did not answer/);
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
