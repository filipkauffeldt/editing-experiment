import { asPhotoId } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { EDIT_HISTORY_LIMIT, EditHistory, type EditStep } from '../src/renderer/edit-history';

const photo = asPhotoId('p1');

function step(log: string[], name: string, at = 0): EditStep {
  return {
    what: name,
    photoIds: [photo],
    at,
    undo: async () => void log.push(`undo ${name}`),
    redo: async () => void log.push(`redo ${name}`),
  };
}

describe('EditHistory', () => {
  it('undoes newest first and redoes in the opposite order', async () => {
    const log: string[] = [];
    const history = new EditHistory();
    history.record(step(log, 'a'));
    history.record(step(log, 'b'));

    expect((await history.undo())?.what).toBe('b');
    expect((await history.undo())?.what).toBe('a');
    expect(await history.undo()).toBeUndefined();
    expect((await history.redo())?.what).toBe('a');
    expect((await history.redo())?.what).toBe('b');
    expect(await history.redo()).toBeUndefined();
    expect(log).toEqual(['undo b', 'undo a', 'redo a', 'redo b']);
  });

  it('drops the redo steps when a new change is recorded', async () => {
    const log: string[] = [];
    const history = new EditHistory();
    history.record(step(log, 'a'));
    await history.undo();
    expect(history.canRedo()).toBe(true);
    history.record(step(log, 'b'));
    expect(history.canRedo()).toBe(false);
  });

  it('runs a second undo only after the first one has written', async () => {
    const log: string[] = [];
    const history = new EditHistory();
    for (const name of ['a', 'b']) {
      history.record({
        what: name,
        photoIds: [photo],
        at: 0,
        undo: async () => {
          log.push(`start ${name}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          log.push(`end ${name}`);
        },
        redo: async () => undefined,
      });
    }
    await Promise.all([history.undo(), history.undo()]);
    expect(log).toEqual(['start b', 'end b', 'start a', 'end a']);
  });

  it('keeps going after a step failed', async () => {
    const history = new EditHistory();
    history.record({
      what: 'ok',
      photoIds: [photo],
      at: 0,
      undo: async () => undefined,
      redo: async () => undefined,
    });
    history.record({
      what: 'bad',
      photoIds: [photo],
      at: 0,
      undo: async () => {
        throw new Error('disk full');
      },
      redo: async () => undefined,
    });
    await expect(history.undo()).rejects.toThrow('disk full');
    expect((await history.undo())?.what).toBe('ok');
  });

  it('reports when the newest step happened and whether a step is the newest', () => {
    const history = new EditHistory();
    expect(history.undoAt()).toBeUndefined();
    const first = step([], 'a', 10);
    const second = step([], 'b', 20);
    history.record(first);
    history.record(second);
    expect(history.undoAt()).toBe(20);
    expect(history.isLast(second)).toBe(true);
    expect(history.isLast(first)).toBe(false);
    history.discard(second);
    expect(history.undoAt()).toBe(10);
  });

  it('keeps a bounded number of steps', async () => {
    const history = new EditHistory();
    for (let index = 0; index < EDIT_HISTORY_LIMIT + 5; index++) {
      history.record(step([], String(index)));
    }
    let count = 0;
    while (await history.undo()) count++;
    expect(count).toBe(EDIT_HISTORY_LIMIT);
  });
});
