import { describe, expect, it } from 'vitest';
import { colorClassFromKey, type ShortcutKeyEvent } from '../src/renderer/rating-keys';
import { zoomKeyAction } from '../src/renderer/zoom-keys';

const event = (init: Partial<ShortcutKeyEvent> & { key: string }): ShortcutKeyEvent => ({
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe('zoom keys', () => {
  it('Z toggles, with no modifier', () => {
    expect(zoomKeyAction(event({ key: 'z', code: 'KeyZ' }), false)).toBe('toggle');
    expect(zoomKeyAction(event({ key: 'Z', code: 'KeyZ', shiftKey: true }), false)).toBe('toggle');
    // Ctrl+Z is the retouch undo, never a zoom.
    expect(zoomKeyAction(event({ key: 'z', ctrlKey: true }), false)).toBeUndefined();
    expect(zoomKeyAction(event({ key: 'z', metaKey: true }), true)).toBeUndefined();
  });

  it('zooms with Ctrl and a plain + and - on a Swedish keyboard (no Shift)', () => {
    // Swedish: + is the physical Minus key and - is the physical Slash key.
    expect(zoomKeyAction(event({ key: '+', code: 'Minus', ctrlKey: true }), false)).toBe('in');
    expect(zoomKeyAction(event({ key: '-', code: 'Slash', ctrlKey: true }), false)).toBe('out');
  });

  it('zooms with Cmd on macOS and ignores Ctrl there', () => {
    expect(zoomKeyAction(event({ key: '+', metaKey: true }), true)).toBe('in');
    expect(zoomKeyAction(event({ key: '-', metaKey: true }), true)).toBe('out');
    expect(zoomKeyAction(event({ key: '+', ctrlKey: true }), true)).toBeUndefined();
    expect(zoomKeyAction(event({ key: '+', metaKey: true }), false)).toBeUndefined();
  });

  it('takes = as an alternative for zooming in, and the numpad keys', () => {
    expect(zoomKeyAction(event({ key: '=', code: 'Equal', ctrlKey: true }), false)).toBe('in');
    expect(zoomKeyAction(event({ key: '+', code: 'NumpadAdd', ctrlKey: true }), false)).toBe('in');
    expect(zoomKeyAction(event({ key: '-', code: 'NumpadSubtract', ctrlKey: true }), false)).toBe(
      'out',
    );
    // A layout that reports another key under Ctrl still has the numpad code.
    expect(
      zoomKeyAction(event({ key: 'Unidentified', code: 'NumpadAdd', ctrlKey: true }), false),
    ).toBe('in');
  });

  it('allows Shift, which a US keyboard needs for +', () => {
    expect(
      zoomKeyAction(event({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }), false),
    ).toBe('in');
  });

  it('never fires for AltGr, which types a character', () => {
    // AltGr arrives as Ctrl+Alt on Windows and Linux.
    expect(
      zoomKeyAction(event({ key: '+', code: 'Minus', ctrlKey: true, altKey: true }), false),
    ).toBeUndefined();
    expect(
      zoomKeyAction(event({ key: '\\', code: 'Minus', ctrlKey: true, altKey: true }), false),
    ).toBeUndefined();
    expect(
      zoomKeyAction(
        {
          ...event({ key: '+', code: 'Minus', ctrlKey: true }),
          getModifierState: (name: string) => name === 'AltGraph',
        },
        false,
      ),
    ).toBeUndefined();
    expect(zoomKeyAction(event({ key: 'z', altKey: true, ctrlKey: true }), false)).toBeUndefined();
  });

  it('leaves å, ä, ö and dead keys alone', () => {
    for (const key of ['å', 'ä', 'ö', 'Dead', '¨']) {
      expect(zoomKeyAction(event({ key }), false)).toBeUndefined();
      expect(zoomKeyAction(event({ key, ctrlKey: true }), false)).toBeUndefined();
    }
  });

  it('leaves Ctrl/Cmd+0 to the colour class clear', () => {
    const zero = event({ key: '0', code: 'Digit0', ctrlKey: true });
    expect(zoomKeyAction(zero, false)).toBeUndefined();
    expect(colorClassFromKey(zero, false)).toBe(0);
    const cmdZero = event({ key: '0', code: 'Digit0', metaKey: true });
    expect(zoomKeyAction(cmdZero, true)).toBeUndefined();
    expect(colorClassFromKey(cmdZero, true)).toBe(0);
  });

  it('does not take other letters or other modified keys', () => {
    expect(zoomKeyAction(event({ key: 'y' }), false)).toBeUndefined();
    expect(zoomKeyAction(event({ key: '1', ctrlKey: true }), false)).toBeUndefined();
    expect(zoomKeyAction(event({ key: '+' }), false)).toBeUndefined();
    expect(zoomKeyAction(event({ key: '-' }), false)).toBeUndefined();
  });
});
