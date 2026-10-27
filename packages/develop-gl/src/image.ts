import type { LinearImageHeader } from '@ee/contracts';

/** Raw sample bytes of a linear image: the body of `app://linear/...` or a typed array of the right type. */
export type LinearImageBuffer = ArrayBuffer | ArrayBufferView;

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/** IEEE half-float bits to number. */
export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/** Number to IEEE half-float bits (round to nearest even, overflow to infinity). */
export function floatToHalf(value: number): number {
  f32Scratch[0] = value;
  const x = u32Scratch[0] ?? 0;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = (mant | 0x800000) >> (1 - e);
    return sign | ((m + 0xfff + ((m >> 13) & 1)) >> 13);
  }
  const rounded = mant + 0xfff + ((mant >> 13) & 1);
  // A mantissa carry bumps the exponent, which is the correct result.
  return sign | (((e << 10) + (rounded >> 13)) & 0xffff);
}

/** Rounds every sample to the nearest half float, as the GPU texture will see them. */
export function quantizeToHalf(samples: Float32Array): Uint16Array {
  const out = new Uint16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = floatToHalf(samples[i] ?? 0);
  return out;
}

/** The bytes of an `ArrayBuffer` or typed array view, without copying. */
export function bytesOf(data: LinearImageBuffer): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Validates the buffer against the header and returns it as typed samples (f16 as raw `Uint16Array` bits). */
export function samplesView(header: LinearImageHeader, data: LinearImageBuffer): Uint16Array | Float32Array {
  const bytes = bytesOf(data);
  const bytesPerSample = header.sampleType === 'f16' ? 2 : 4;
  const expected = header.width * header.height * 4 * bytesPerSample;
  if (bytes.byteLength !== expected) {
    throw new RangeError(
      `Linear image buffer has ${bytes.byteLength} bytes, expected ${expected} for ${header.width}x${header.height} ${header.sampleType}`,
    );
  }
  // Typed array views need aligned offsets; copy only when the input is not.
  const aligned =
    bytes.byteOffset % bytesPerSample === 0 ? bytes : new Uint8Array(bytes);
  return header.sampleType === 'f16'
    ? new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2)
    : new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}

/** Decodes the whole buffer to float32 RGBA (used by the CPU reference). */
export function toFloat32Samples(header: LinearImageHeader, data: LinearImageBuffer): Float32Array {
  const view = samplesView(header, data);
  if (view instanceof Float32Array) return view;
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) out[i] = halfToFloat(view[i] ?? 0);
  return out;
}
