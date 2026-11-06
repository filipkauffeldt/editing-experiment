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

/** A field being edited: the typed edits the caption makes, each followed by the instant check. */
class Field {
  constructor(
    public text: string,
    public caret: number,
    private readonly table: CodeReplacementSet = set,
  ) {}

  /** What the check does after an edit that leaves the caret where it is now. */
  private check(): this {
    const hit = instantReplacement(this.text, this.caret, this.table);
    if (hit) {
      this.text = this.text.slice(0, hit.start) + hit.replacement + this.text.slice(hit.end);
      this.caret = hit.start + hit.replacement.length;
    }
    return this;
  }

  type(chars: string): this {
    for (const char of chars) {
      this.text = this.text.slice(0, this.caret) + char + this.text.slice(this.caret);
      this.caret += 1;
      this.check();
    }
    return this;
  }

  backspace(count = 1): this {
    for (let i = 0; i < count; i++) {
      if (this.caret === 0) break;
      this.text = this.text.slice(0, this.caret - 1) + this.text.slice(this.caret);
      this.caret -= 1;
      this.check();
    }
    return this;
  }

  delete(count = 1): this {
    for (let i = 0; i < count; i++) {
      this.text = this.text.slice(0, this.caret) + this.text.slice(this.caret + 1);
      this.check();
    }
    return this;
  }

  /** Move the caret without editing: no check, as an arrow key or a click. */
  at(caret: number): this {
    this.caret = caret;
    return this;
  }
}

describe('instantReplacement after any typed edit', () => {
  it('expands a token that had no match once an edit inside it makes a known code', () => {
    // =foo= typed and left; the caret goes back inside and the code is retyped.
    const typed = new Field('=foo=', 5).at(4).backspace(3).type('t1');
    expect(typed.text).toBe('GAIS');
    expect(typed.caret).toBe(4);
    // Typing inside, without deleting first: =t1x= has no match, and removing x makes one.
    expect(new Field('=t1x=', 4).backspace().text).toBe('GAIS');
  });

  it('expands from Backspace in =t1x= and from Delete in =xt1=, with the caret after the replacement', () => {
    const backspaced = new Field('Goal =t1x= more', 9).backspace();
    expect(backspaced.text).toBe('Goal GAIS more');
    expect(backspaced.caret).toBe('Goal GAIS'.length);

    const deleted = new Field('Goal =xt1= more', 6).delete();
    expect(deleted.text).toBe('Goal GAIS more');
    expect(deleted.caret).toBe('Goal GAIS'.length);
  });

  it('expands when a code is made known by typing in the middle of the token', () => {
    const field = new Field('=t1=', 3).type('x');
    expect(field.text).toBe('=t1x=');
    expect(field.backspace().text).toBe('GAIS');
    expect(new Field('=tt1=', 2).backspace().text).toBe('GAIS');
  });

  it('expands when an opening delimiter is typed in front of existing text', () => {
    const field = new Field('t1= and more', 0).type('=');
    expect(field.text).toBe('GAIS and more');
    expect(field.caret).toBe(4);
    expect(new Field('Goal t2=', 5).type('=').text).toBe('Goal AIK');
  });

  it('expands for a Backspace or Delete that leaves the caret right after a token', () => {
    expect(new Field('=t1=x', 5).backspace().text).toBe('GAIS');
    expect(new Field('=t1=x', 4).delete().text).toBe('GAIS');
  });

  it('leaves a token with no match alone however it is edited', () => {
    const field = new Field('=foo=', 4).backspace().type('o');
    expect(field.text).toBe('=foo=');
    expect(new Field('=foo=', 5).type('x').text).toBe('=foo=x');
    expect(new Field('=zz=', 3).delete().text).toBe('=zz');
  });

  it('never expands while editing ordinary text outside a token', () => {
    expect(new Field('plain t1 text', 8).type('x').backspace().text).toBe('plain t1 text');
    expect(new Field('=zz= and t1', 11).type(' t1').text).toBe('=zz= and t1 t1');
    expect(new Field('t1', 2).backspace().type('1').text).toBe('t1');
  });

  it('does not expand a token with spaces in it unless the file has exactly that code', () => {
    expect(new Field('a=b c=d', 5).type('x').backspace().text).toBe('a=b c=d');
    expect(new Field('a=b c=d', 3).delete().type(' ').text).toBe('a=b c=d');
    const withSpace = new CodeReplacementSet([parseCodeReplacementFile('b c\tBEE SEE')]);

    expect(new Field('a=b c=d', 5, withSpace).type('x').backspace().text).toBe('aBEE SEEd');
  });

  it('needs an exact code: case sensitive, no partial match', () => {
    expect(new Field('=T1x=', 4).backspace().text).toBe('=T1=');
    expect(new Field('=t1 =', 4).backspace().text).toBe('GAIS');
    expect(new Field('= t1=', 2).backspace().text).toBe('GAIS');
    expect(new Field('=t1t=', 4).backspace().text).toBe('GAIS');
    expect(new Field('=å1x=', 4).backspace().text).toBe('=å1=');
    expect(new Field('=Å1x=', 4).backspace().text).toBe('Ångelholm');
  });

  it('keeps a token on one line', () => {
    expect(new Field('=t1\nx=', 3).type('x').text).toBe('=t1x\nx=');
    expect(new Field('x=\nt1=', 3).delete(0).type('').text).toBe('x=\nt1=');
    expect(new Field('x=\n=t1', 6).type('=').text).toBe('x=\nGAIS');
    expect(new Field('=\nt1=', 4).type('').backspace().type('1').text).toBe('=\nt1=');
  });

  it('does nothing after an undo restores the typed code until the next edit that makes a known code', () => {
    // Undo is not a typed edit, so the check never runs for it: the caption keeps the =t1= it was given.
    const restored = new Field('Goal =t1=', 9);
    expect(restored.text).toBe('Goal =t1=');
    // Typing after it, or elsewhere, does not touch the code.
    expect(restored.type(' x').text).toBe('Goal =t1= x');
    expect(new Field('Goal =t1=', 9).at(0).type('A').text).toBe('AGoal =t1=');
    // An edit that leaves an exact known code does expand it.
    expect(new Field('Goal =t1=', 8).type('x').backspace().text).toBe('Goal GAIS');
  });

  it('expands a typed code at the first delimiter that closes it when the earlier one found nothing', () => {
    expect(new Field('=x=', 3).type('t1=').text).toBe('=xGAIS');
  });
});

describe('instantReplacement with a column selector', () => {
  // Three columns, as a .tsv: the first is the default.
  const columns = new CodeReplacementSet([
    parseCodeReplacementFile('a10\tAlfa\tBravo\tCharlie\nÅ2\tÅre\tÄlvsbyn'),
  ]);

  it('replaces =code#N= with that column when the closing delimiter is typed', () => {
    expect(new Field('', 0, columns).type('=a10#2=').text).toBe('Bravo');
    expect(new Field('', 0, columns).type('=a10#3=').text).toBe('Charlie');
    expect(new Field('', 0, columns).type('=a10#1=').text).toBe('Alfa');
    expect(new Field('', 0, columns).type('=a10=').text).toBe('Alfa');
    expect(new Field('', 0, columns).type('Goal =Å2#2= now').text).toBe('Goal Älvsbyn now');
    expect(new Field('', 0, columns).type('=a10#2=').caret).toBe(5);
  });

  it('leaves a column that does not exist as typed, and a code that is not known', () => {
    expect(new Field('', 0, columns).type('=a10#9=').text).toBe('=a10#9=');
    expect(new Field('', 0, columns).type('=a10#0=').text).toBe('=a10#0=');
    expect(new Field('', 0, columns).type('=zz#2=').text).toBe('=zz#2=');
    expect(new Field('', 0, columns).type('=A10#2=').text).toBe('=A10#2=');
  });

  it('expands a closed =a10#9= once an edit inside it makes =a10#2=', () => {
    const field = new Field('', 0, columns).type('Goal =a10#9= more');
    expect(field.text).toBe('Goal =a10#9= more');
    field.at('Goal =a10#9'.length).backspace().type('2');
    expect(field.text).toBe('Goal Bravo more');
    expect(field.caret).toBe('Goal Bravo'.length);
    // And by Delete, and by editing the number into place.
    expect(new Field('=a10#92=', 6, columns).backspace().text).toBe('Bravo');
    expect(new Field('=a10#x2=', 5, columns).delete().text).toBe('Bravo');
    expect(new Field('a10#2=', 0, columns).type('=').text).toBe('Bravo');
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
