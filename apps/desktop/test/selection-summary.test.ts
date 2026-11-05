import { describe, expect, it } from 'vitest';
import { sharedKeywords, sharedText, takenRange } from '../src/renderer/selection-summary';

describe('sharedText', () => {
  it('is the value when every photo has it', () => {
    expect(sharedText(['Z 9', 'Z 9'])).toEqual({ kind: 'same', value: 'Z 9' });
  });

  it('differs, listing each value once, and counts a missing value as different', () => {
    expect(sharedText(['Z 9', 'Z 8', 'Z 9'])).toEqual({ kind: 'differs', values: ['Z 9', 'Z 8'] });
    expect(sharedText(['Z 9', undefined]).kind).toBe('differs');
  });
});

describe('sharedKeywords', () => {
  it('ignores the order keywords were written in', () => {
    expect(
      sharedKeywords([
        ['a', 'b'],
        ['b', 'a'],
      ]).kind,
    ).toBe('same');
    expect(sharedKeywords([['a'], ['a', 'b']]).kind).toBe('differs');
    expect(sharedKeywords([undefined, []]).kind).toBe('same');
  });
});

describe('takenRange', () => {
  it('gives the date once for one day and both for several', () => {
    expect(takenRange(['2026-10-24T19:12:07', '2026-10-24T18:54:07'])).toBe(
      '2026-10-24 18:54:07 to 19:12:07',
    );
    expect(takenRange(['2026-10-25T09:00:00', '2026-10-24T18:54:07'])).toBe(
      '2026-10-24 18:54:07 to 2026-10-25 09:00:00',
    );
  });

  it('is the one time when they are equal, and empty without any', () => {
    expect(takenRange(['2026-10-24T18:54:07', '2026-10-24T18:54:07'])).toBe('2026-10-24 18:54:07');
    expect(takenRange([undefined])).toBe('');
  });
});
