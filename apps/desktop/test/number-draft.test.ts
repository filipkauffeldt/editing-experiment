import { describe, expect, it } from 'vitest';
import { clampNumber, parseNumberDraft } from '../src/renderer/number-draft';

describe('typed number drafts', () => {
  it('accepts whole numbers, dot decimals and the comma of a Swedish keyboard', () => {
    expect(parseNumberDraft('73')).toBe(73);
    expect(parseNumberDraft('-4.5')).toBe(-4.5);
    expect(parseNumberDraft('3,5')).toBe(3.5);
    expect(parseNumberDraft('+2')).toBe(2);
    expect(parseNumberDraft('.5')).toBe(0.5);
    expect(parseNumberDraft(' 3, ')).toBe(3);
  });

  it('leaves a half-typed or invalid draft unparsed', () => {
    for (const draft of ['', ' ', '-', '+', '.', ',', '12px', '1,2,3', '3..5', 'e3', '--2']) {
      expect(parseNumberDraft(draft)).toBeUndefined();
    }
  });

  it('clamps to the slider range and snaps to its step', () => {
    expect(clampNumber(9999, 8, 256, 1)).toBe(256);
    expect(clampNumber(1, 8, 256, 1)).toBe(8);
    expect(clampNumber(48.4, 8, 256, 1)).toBe(48);
    expect(clampNumber(-90, -45, 45, 0.1)).toBe(-45);
    expect(clampNumber(90, -45, 45, 0.1)).toBe(45);
    expect(clampNumber(3.55, -45, 45, 0.1)).toBe(3.6);
    expect(clampNumber(-12.34, -45, 45, 0.1)).toBe(-12.3);
    expect(clampNumber(80, 0, 50, 1)).toBe(50);
  });
});
