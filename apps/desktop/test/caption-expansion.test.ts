import { describe, expect, it } from 'vitest';
import { caretThroughChange, changedRange } from '../src/renderer/caption-expansion';

describe('changedRange', () => {
  it('finds the one stretch a code replacement changed', () => {
    expect(changedRange('Goal for =t1= by Foo', 'Goal for GAIS by Foo')).toEqual({
      start: 9,
      end: 13,
      text: 'GAIS',
    });
  });

  it('does not overlap the shared start and end when a repeat is replaced', () => {
    expect(changedRange('aa', 'aaa')).toEqual({ start: 2, end: 2, text: 'a' });
    expect(changedRange('=a==a=', '=a=')).toEqual({ start: 3, end: 6, text: '' });
  });

  it('is empty for equal texts and the whole text for unrelated ones', () => {
    expect(changedRange('same', 'same')).toEqual({ start: 4, end: 4, text: '' });
    expect(changedRange('abc', 'xyz')).toEqual({ start: 0, end: 3, text: 'xyz' });
  });
});

describe('caretThroughChange', () => {
  const change = { start: 9, end: 13, text: 'GAIS and more' };

  it('keeps a caret before the change, shifts one after it and moves one inside to its end', () => {
    expect(caretThroughChange(4, change)).toBe(4);
    expect(caretThroughChange(9, change)).toBe(9);
    expect(caretThroughChange(11, change)).toBe(22);
    expect(caretThroughChange(13, change)).toBe(22);
    expect(caretThroughChange(20, change)).toBe(29);
  });
});
