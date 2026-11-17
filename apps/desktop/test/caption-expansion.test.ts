import { describe, expect, it } from 'vitest';
import {
  caretThroughChange,
  changedRange,
  removeSpans,
  typedSpans,
} from '../src/renderer/caption-expansion';

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

describe('typedSpans', () => {
  it('gives the stretch of one code, as typed', () => {
    // "hello =a1= goodbye" with =a1= (4 characters) written as "Name Namesson" (13).
    expect(typedSpans([[{ from: 6, to: 10, newFrom: 6, newTo: 19 }], []])).toEqual([
      { from: 6, to: 10 },
    ]);
  });

  it('carries a later pass back through an earlier one', () => {
    const codes = [{ from: 0, to: 4, newFrom: 0, newTo: 13 }];
    // The variable stood at 5 in the typed text, after the code and a space: 14 once the code wrote 13.
    const variables = [{ from: 14, to: 20, newFrom: 14, newTo: 20 }];
    expect(typedSpans([codes, variables])).toEqual([
      { from: 0, to: 4 },
      { from: 5, to: 11 },
    ]);
  });

  it('counts a variable that a code wrote as part of the code', () => {
    const codes = [{ from: 2, to: 6, newFrom: 2, newTo: 20 }];
    const variables = [{ from: 5, to: 15, newFrom: 5, newTo: 9 }];
    expect(typedSpans([codes, variables])).toEqual([{ from: 2, to: 6 }]);
  });

  it('joins stretches that touch', () => {
    const codes = [{ from: 5, to: 9, newFrom: 5, newTo: 8 }];
    const variables = [{ from: 1, to: 5, newFrom: 1, newTo: 3 }];
    expect(typedSpans([codes, variables])).toEqual([{ from: 1, to: 9 }]);
  });
});

describe('removeSpans', () => {
  it('takes a code out and collapses the two spaces it leaves', () => {
    const removed = removeSpans('hello =a1= goodbye', [{ from: 6, to: 10 }]);
    expect(removed.text).toBe('hello goodbye');
    expect(removed.caretAt(10)).toBe(6);
    expect(removed.caretAt(6)).toBe(6);
    expect(removed.caretAt(18)).toBe(13);
  });

  it('leaves a single space alone', () => {
    expect(removeSpans('hello =a1=, bye', [{ from: 6, to: 10 }]).text).toBe('hello , bye');
    expect(removeSpans('=a1= goodbye', [{ from: 0, to: 4 }]).text).toBe(' goodbye');
    expect(removeSpans('hello =a1=', [{ from: 6, to: 10 }]).text).toBe('hello ');
  });

  it('removes several codes and collapses each place', () => {
    const typed = 'x =a= =b= y';
    const removed = removeSpans(typed, [
      { from: 2, to: 5 },
      { from: 6, to: 9 },
    ]);
    expect(removed.text).toBe('x y');
    expect(removed.caretAt(9)).toBe(2);
  });

  it('collapses around two codes that touch', () => {
    expect(
      removeSpans('x =a==b= y', [
        { from: 2, to: 5 },
        { from: 5, to: 8 },
      ]).text,
    ).toBe('x y');
  });

  it('does not touch a text without spans', () => {
    const removed = removeSpans('same  text', []);
    expect(removed.text).toBe('same  text');
    expect(removed.caretAt(4)).toBe(4);
  });
});
