import { describe, expect, it } from 'vitest';
import {
  colorClassFromKey,
  ratingFromKey,
  type ShortcutKeyEvent,
} from '../src/renderer/rating-keys';

function event(patch: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key: '1',
    code: 'Digit1',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...patch,
  };
}

describe('rating keys', () => {
  it('maps 1-5 and 0 from the printed digit, top row or numpad', () => {
    expect([0, 1, 2, 3, 4, 5].map((digit) => ratingFromKey(event({ key: String(digit) })))).toEqual(
      [0, 1, 2, 3, 4, 5],
    );
    expect([6, 7, 8, 9].map((digit) => ratingFromKey(event({ key: String(digit) })))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(ratingFromKey(event({ key: '3', code: 'Numpad3' }))).toBe(3);
  });

  it('does not fire for Shift+digit symbols, AltGr, dead keys or modifiers', () => {
    expect(ratingFromKey(event({ key: '!', code: 'Digit1', shiftKey: true }))).toBeUndefined();
    expect(ratingFromKey(event({ key: '¤', code: 'Digit4', shiftKey: true }))).toBeUndefined();
    expect(ratingFromKey(event({ key: '1', ctrlKey: true, altKey: true }))).toBeUndefined();
    expect(ratingFromKey(event({ key: '1', altKey: true }))).toBeUndefined();
    expect(ratingFromKey(event({ key: '1', ctrlKey: true }))).toBeUndefined();
    expect(ratingFromKey(event({ key: '1', metaKey: true }))).toBeUndefined();
    expect(ratingFromKey(event({ key: 'Dead', code: 'Quote' }))).toBeUndefined();
    expect(ratingFromKey(event({ key: 'å', code: 'Quote' }))).toBeUndefined();
  });
});

describe('colour-class keys', () => {
  it('uses Ctrl on Linux and macOS Command, with Ctrl for clearing', () => {
    expect(colorClassFromKey(event({ key: '1', ctrlKey: true }), false)).toBe(1);
    expect(colorClassFromKey(event({ key: '0', code: 'Digit0', ctrlKey: true }), false)).toBe(0);
    expect(colorClassFromKey(event({ key: '8', code: 'Digit8', ctrlKey: true }), false)).toBe(8);
    expect(colorClassFromKey(event({ key: '9', code: 'Digit9', ctrlKey: true }), false)).toBe(
      undefined,
    );

    expect(colorClassFromKey(event({ key: '3', metaKey: true }), true)).toBe(3);
    expect(colorClassFromKey(event({ key: '3', metaKey: true }), false)).toBeUndefined();
    expect(colorClassFromKey(event({ key: '3', ctrlKey: true }), true)).toBeUndefined();
  });

  it('falls back to the physical Digit/Numpad code when the layout changes event.key', () => {
    expect(colorClassFromKey(event({ key: '!', code: 'Digit1', ctrlKey: true }), false)).toBe(1);
    expect(colorClassFromKey(event({ key: 'End', code: 'Numpad1', ctrlKey: true }), false)).toBe(1);
    expect(colorClassFromKey(event({ key: 'End', code: 'Numpad0', ctrlKey: true }), false)).toBe(0);
  });

  it('never treats AltGr as a colour-class shortcut', () => {
    const altGr = event({ key: '7', code: 'Digit7', ctrlKey: true, altKey: true });
    expect(colorClassFromKey(altGr, false)).toBeUndefined();
    expect(
      colorClassFromKey(
        event({
          key: '7',
          code: 'Digit7',
          ctrlKey: true,
          getModifierState: (key) => key === 'AltGraph',
        }),
        false,
      ),
    ).toBeUndefined();
  });

  it('ignores Shift+digit symbols, plain digits and the wrong modifier', () => {
    expect(
      colorClassFromKey(event({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), false),
    ).toBeUndefined();
    expect(colorClassFromKey(event({ key: '4' }), false)).toBeUndefined();
    expect(colorClassFromKey(event({ key: '4', altKey: true }), false)).toBeUndefined();
  });
});
