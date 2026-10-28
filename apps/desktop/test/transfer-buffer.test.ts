import { describe, expect, it } from 'vitest';
import { transferableBuffer } from '../src/renderer/transfer-buffer';

describe('transferableBuffer', () => {
  it('transfers the underlying buffer without copying when the view covers it', () => {
    const view = new Uint8Array(16);
    expect(transferableBuffer(view)).toBe(view.buffer);
  });

  it('copies a subarray so only its bytes are transferred', () => {
    const backing = new Uint8Array(16);
    const view = backing.subarray(4, 8);
    const buffer = transferableBuffer(view);
    expect(buffer).not.toBe(backing.buffer);
    expect(buffer.byteLength).toBe(4);
  });
});
