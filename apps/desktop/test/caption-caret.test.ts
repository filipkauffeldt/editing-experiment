import { describe, expect, it } from 'vitest';
import { captionCaretPosition } from '../src/renderer/caption-caret';

describe('caption caret position', () => {
  it("starts after the date in the user's caption, keeping its newlines", () => {
    const caption = `20261102 under fotbollsmatchen i Allsvenskan mellan GAIS och AIK den 2 november 2026 på Gamla Ullevi i Göteborg.

Foto: Filip Kauffeldt`;
    expect(captionCaretPosition(caption)).toBe('20261102 '.length);
  });

  it('skips several spaces and any whitespace after the date', () => {
    expect(captionCaretPosition('20261102   under fotbollsmatchen')).toBe('20261102   '.length);
    expect(captionCaretPosition('20261102\n\nFoto: Filip Kauffeldt')).toBe('20261102\n\n'.length);
    expect(captionCaretPosition('20261102\tunder')).toBe('20261102\t'.length);
  });

  it('goes to the end when the date is followed by only whitespace', () => {
    expect(captionCaretPosition('20261102   ')).toBe('20261102   '.length);
    expect(captionCaretPosition('20261102\n')).toBe('20261102\n'.length);
  });

  it('goes to the end of a caption that is exactly eight digits', () => {
    expect(captionCaretPosition('20261102')).toBe(8);
  });

  it('does not validate the date as a calendar date', () => {
    expect(captionCaretPosition('20261340 under fotbollsmatchen')).toBe('20261340 '.length);
  });

  it('stays at the start for anything that is not a leading eight-digit date', () => {
    expect(captionCaretPosition('')).toBe(0);
    expect(captionCaretPosition('Sprinter at the finish line')).toBe(0);
    expect(captionCaretPosition('2026110 under fotbollsmatchen')).toBe(0);
    expect(captionCaretPosition('202611023 under fotbollsmatchen')).toBe(0);
    expect(captionCaretPosition('20261102abc under fotbollsmatchen')).toBe(0);
    expect(captionCaretPosition('Foto: 20261102 under fotbollsmatchen')).toBe(0);
    expect(captionCaretPosition(' 20261102 under fotbollsmatchen')).toBe(0);
  });
});
