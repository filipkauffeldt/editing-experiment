import { describe, expect, it } from 'vitest';
import { expandCaption } from '../src/caption';
import {
  CodeReplacementSet,
  expandCodeReplacements,
  instantReplacement,
  mapCaret,
  mapCaretThrough,
  parseCodeReplacementFile,
} from '../src/code-replacement-tokens';

const FILE = [
  't1\tGAIS',
  't2\tAIK\tAllsvenskan',
  'Å1\tÅngelholm',
  'eq\ta=b',
  'loop\t=t1=',
  'when\t{date}',
].join('\n');

const set = new CodeReplacementSet([parseCodeReplacementFile(FILE)]);

/** The text after typing `typed`, expanding the way the field does on each closing delimiter. */
function type(typed: string, table = set): string {
  let text = '';
  for (const char of typed) {
    text += char;
    const hit = instantReplacement(text, text.length, table);
    if (hit) text = text.slice(0, hit.start) + hit.replacement;
  }
  return text;
}

describe('instantReplacement', () => {
  it('replaces a known code when its closing delimiter is typed', () => {
    expect(instantReplacement('Goal =t1=', 9, set)).toEqual({
      start: 5,
      end: 9,
      replacement: 'GAIS',
    });
    expect(type('Goal =t1= scores')).toBe('Goal GAIS scores');
  });

  it('leaves text that does not end a known token alone', () => {
    for (const text of ['a=b', '=t1', '=zz=', '==', '=', 't1=', '=t1x=', '=T1=']) {
      expect(instantReplacement(text, text.length, set), text).toBeUndefined();
    }
  });

  it('only looks at the delimiter just before the caret', () => {
    expect(instantReplacement('=t1= more', 4, set)).toEqual({
      start: 0,
      end: 4,
      replacement: 'GAIS',
    });
    expect(instantReplacement('=t1= more', 9, set)).toBeUndefined();
  });

  it('lets the closing delimiter of a token with no match open the next one', () => {
    expect(type('=x=t1=')).toBe('=x' + 'GAIS');
    expect(type('a=b=t1=')).toBe('a=bGAIS');
    expect(type('a=b=c')).toBe('a=b=c');
  });

  it('is case sensitive and handles Å in a code and a replacement', () => {
    expect(type('=t1=')).toBe('GAIS');
    expect(type('=T1=')).toBe('=T1=');
    expect(type('=Å1=')).toBe('Ångelholm');
    expect(type('=å1=')).toBe('=å1=');
  });

  it('picks a column with #N and follows the later file for a code both define', () => {
    expect(type('=t2#2=')).toBe('Allsvenskan');
    expect(type('=t2#3=')).toBe('=t2#3=');
    const later = new CodeReplacementSet([
      parseCodeReplacementFile('t1\tGAIS\nt9\tnine'),
      parseCodeReplacementFile('t1\tAIK'),
    ]);
    expect(type('=t1= =t9=', later)).toBe('AIK nine');
  });

  it('expands once: a replacement with a delimiter, or that looks like a code, is left as it is', () => {
    expect(type('=eq=')).toBe('a=b');
    expect(type('=loop=')).toBe('=t1=');
    expect(type('=when=')).toBe('{date}');
  });

  it('agrees with the blur expansion on every token it reads the same way', () => {
    for (const text of ['=t1=', 'Goal =t1= now', '=t2#2= and =Å1=', '=eq=']) {
      let typed = '';
      for (const char of text) {
        typed += char;
        const hit = instantReplacement(typed, typed.length, set);
        if (hit) typed = typed.slice(0, hit.start) + hit.replacement;
      }
      expect(typed, text).toBe(expandCodeReplacements(text, set).text);
    }
  });
});

describe('mapCaret', () => {
  const edits = [{ from: 2, to: 6, newFrom: 2, newTo: 10 }];

  it('keeps a caret before the replaced text and moves one after it by the difference', () => {
    expect(mapCaret(0, edits)).toBe(0);
    expect(mapCaret(2, edits)).toBe(2);
    expect(mapCaret(8, edits)).toBe(12);
  });

  it('puts a caret inside or right after the replaced text at the end of the replacement', () => {
    expect(mapCaret(4, edits)).toBe(10);
    expect(mapCaret(6, edits)).toBe(10);
  });

  it('maps through the code pass and then the variable pass of an expansion', () => {
    const text = 'Before =when= after {filename}';
    const { text: expanded, edits: passes } = expandCaption(text, {
      codeReplacementSet: set,
      fileName: 'a.jpg',
      captureTime: '2026-11-04T19:00:00',
    });
    expect(expanded).toBe('Before 2026-11-04 after a.jpg');
    const caret = (at: number): number => mapCaretThrough(at, passes);
    // Right after the code: at the end of what it became, before the text that follows.
    expect(expanded.slice(0, caret('Before =when='.length))).toBe('Before 2026-11-04');
    // In the text after both: the same text follows the caret.
    expect(expanded.slice(caret('Before =when= after'.length))).toBe(' a.jpg');
    // Before everything it is where it was.
    expect(caret(3)).toBe(3);
  });
});
