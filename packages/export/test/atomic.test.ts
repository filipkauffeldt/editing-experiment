import { describe, expect, it } from 'vitest';
import { atomicReplace, type AtomicFsOps } from '../src/atomic';

interface FakeFileSystem {
  files: Map<string, string>;
  renames: [string, string][];
}

function fakeOps(
  files: Record<string, string>,
  failRename?: (from: string, to: string) => NodeJS.ErrnoException | undefined,
): { ops: AtomicFsOps; state: FakeFileSystem } {
  const state: FakeFileSystem = {
    files: new Map(Object.entries(files)),
    renames: [],
  };
  return {
    state,
    ops: {
      async rename(from, to) {
        state.renames.push([from, to]);
        const failure = failRename?.(from, to);
        if (failure !== undefined) throw failure;
        const content = state.files.get(from);
        if (content === undefined) {
          const error = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        state.files.delete(from);
        state.files.set(to, content);
      },
      async rm(path) {
        state.files.delete(path);
      },
      randomId: () => 'fixed-id',
    },
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('atomicReplace', () => {
  it('replaces an existing target after a Windows EPERM', async () => {
    let first = true;
    const { ops, state } = fakeOps({ '/out/.tmp': 'new', '/out/frame.jpg': 'old' }, (from) => {
      if (from === '/out/.tmp' && first) {
        first = false;
        return errno('EPERM');
      }
      return undefined;
    });

    await atomicReplace('/out/.tmp', '/out/frame.jpg', ops);
    expect(state.files.get('/out/frame.jpg')).toBe('new');
    expect(state.files.has('/out/.tmp')).toBe(false);
    expect(state.files.has('/out/frame.jpg.fixed-id.bak')).toBe(false);
  });

  it('restores the previous target when the swap fails', async () => {
    let tempRenames = 0;
    const { ops, state } = fakeOps({ '/out/.tmp': 'new', '/out/frame.jpg': 'old' }, (from) => {
      if (from !== '/out/.tmp') return undefined;
      tempRenames++;
      return tempRenames === 1 ? errno('EPERM') : errno('EIO');
    });

    await expect(atomicReplace('/out/.tmp', '/out/frame.jpg', ops)).rejects.toThrow();
    expect(state.files.get('/out/frame.jpg')).toBe('old');
    expect(state.files.has('/out/.tmp')).toBe(true);
  });

  it('fails without deleting the target for unrelated errors', async () => {
    const { ops, state } = fakeOps({ '/out/.tmp': 'new', '/out/frame.jpg': 'old' }, () =>
      errno('EISDIR'),
    );

    await expect(atomicReplace('/out/.tmp', '/out/frame.jpg', ops)).rejects.toMatchObject({
      code: 'EISDIR',
    });
    expect(state.files.get('/out/frame.jpg')).toBe('old');
  });
});
