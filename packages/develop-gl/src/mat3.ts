/** Minimal 3x3 helpers. Matrices are row-major `number[9]`, vectors `[x, y, z]`. */

export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly number[];

export function mulMatVec(m: Mat3, v: Vec3): [number, number, number] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  return [a * v[0] + b * v[1] + c * v[2], d * v[0] + e * v[1] + f * v[2], g * v[0] + h * v[1] + i * v[2]];
}

export function mulMat(a: Mat3, b: Mat3): number[] {
  const out: number[] = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[r * 3 + k] ?? 0) * (b[k * 3 + c] ?? 0);
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

/** Inverse of a 3x3 matrix; throws on a singular matrix. */
export function invert(m: Mat3): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new RangeError('Singular 3x3 matrix');
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

/** `m * diag(s)`: scales the columns of `m`, i.e. applies the per-channel gain `s` first. */
export function scaleColumns(m: Mat3, s: Vec3): number[] {
  return m.map((value, index) => value * (s[index % 3] ?? 1));
}

export const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
