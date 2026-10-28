/**
 * The buffer to transfer to/from a worker for a byte view. When the view covers
 * the whole buffer (the normal case for a rendered RGBA image) no copy is made.
 */
export function transferableBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = view.buffer as ArrayBuffer;
  if (view.byteOffset === 0 && view.byteLength === buffer.byteLength) return buffer;
  return buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
