/**
 * Colour temperature / tint <-> CIE xy chromaticity, using Robertson's
 * isotemperature-line method exactly as the Adobe DNG SDK does in
 * `dng_temperature` (dng_temperature.cpp, `Set_xy_coord` / `Get_xy_coord`).
 *
 * Ported from the Adobe DNG SDK (c) Adobe Systems Incorporated, which is
 * distributed under a permissive licence that allows use, modification and
 * redistribution of the source with the copyright notice kept. The Robertson
 * table is the published one (Wyszecki & Stiles, "Color Science", table 3(4.11)).
 *
 * Tint follows Adobe's sign convention: positive tint = greener illuminant, so
 * the image is corrected towards magenta, matching the Lightroom slider.
 */

interface IsoLine {
  /** Reciprocal temperature in micro-reciprocal-Kelvin (mired). */
  r: number;
  /** CIE 1960 UCS coordinates of the black-body point. */
  u: number;
  v: number;
  /** Slope of the isotemperature line. */
  t: number;
}

// prettier-ignore
const TABLE: readonly IsoLine[] = [
  { r: 0, u: 0.18006, v: 0.26352, t: -0.24341 },
  { r: 10, u: 0.18066, v: 0.26589, t: -0.25479 },
  { r: 20, u: 0.18133, v: 0.26846, t: -0.26876 },
  { r: 30, u: 0.18208, v: 0.27119, t: -0.28539 },
  { r: 40, u: 0.18293, v: 0.27407, t: -0.3047 },
  { r: 50, u: 0.18388, v: 0.27709, t: -0.32675 },
  { r: 60, u: 0.18494, v: 0.28021, t: -0.35156 },
  { r: 70, u: 0.18611, v: 0.28342, t: -0.37915 },
  { r: 80, u: 0.1874, v: 0.28668, t: -0.40955 },
  { r: 90, u: 0.1888, v: 0.28997, t: -0.44278 },
  { r: 100, u: 0.19032, v: 0.29326, t: -0.47888 },
  { r: 125, u: 0.19462, v: 0.30141, t: -0.58204 },
  { r: 150, u: 0.19962, v: 0.30921, t: -0.70471 },
  { r: 175, u: 0.20525, v: 0.31647, t: -0.84901 },
  { r: 200, u: 0.21142, v: 0.32312, t: -1.0182 },
  { r: 225, u: 0.21807, v: 0.32909, t: -1.2168 },
  { r: 250, u: 0.22511, v: 0.33439, t: -1.4512 },
  { r: 275, u: 0.23247, v: 0.33904, t: -1.7298 },
  { r: 300, u: 0.2401, v: 0.34308, t: -2.0637 },
  { r: 325, u: 0.24792, v: 0.34655, t: -2.4681 },
  { r: 350, u: 0.25591, v: 0.34951, t: -2.9641 },
  { r: 375, u: 0.264, v: 0.352, t: -3.5814 },
  { r: 400, u: 0.27218, v: 0.35407, t: -4.3633 },
  { r: 425, u: 0.28039, v: 0.35577, t: -5.3762 },
  { r: 450, u: 0.28863, v: 0.35714, t: -6.7262 },
  { r: 475, u: 0.29685, v: 0.35823, t: -8.5955 },
  { r: 500, u: 0.30505, v: 0.35907, t: -11.324 },
  { r: 525, u: 0.3132, v: 0.35968, t: -15.628 },
  { r: 550, u: 0.32129, v: 0.36011, t: -23.325 },
  { r: 575, u: 0.32931, v: 0.36038, t: -40.77 },
  { r: 600, u: 0.33724, v: 0.36051, t: -116.45 },
];

/** Mired distance in UCS of one tint unit (the SDK's `kTintScale`). */
const TINT_SCALE = -3000;

export interface TemperatureTint {
  /** Kelvin. */
  temperature: number;
  tint: number;
}

export interface XY {
  x: number;
  y: number;
}

const line = (index: number): IsoLine => {
  const entry = TABLE[index];
  if (!entry) throw new RangeError(`Robertson table index ${index} out of range`);
  return entry;
};

/** Chromaticity (CIE 1931 xy) to temperature and tint. */
export function xyToTemperatureTint(xy: XY): TemperatureTint {
  const denom = 1.5 - xy.x + 6 * xy.y;
  const u = (2 * xy.x) / denom;
  const v = (3 * xy.y) / denom;

  let lastDt = 0;
  let lastDu = 0;
  let lastDv = 0;

  for (let index = 1; index <= 30; index++) {
    const cur = line(index);
    let du = 1;
    let dv = cur.t;
    const len = Math.hypot(1, dv);
    du /= len;
    dv /= len;

    let uu = u - cur.u;
    let vv = v - cur.v;
    // Signed distance above/below the isotemperature line.
    let dt = -uu * dv + vv * du;

    if (dt <= 0 || index === 30) {
      if (dt > 0) dt = 0;
      dt = -dt;
      const f = index === 1 ? 0 : dt / (lastDt + dt);
      const prev = line(index - 1);

      const temperature = 1e6 / (prev.r * f + cur.r * (1 - f));

      uu = u - (prev.u * f + cur.u * (1 - f));
      vv = v - (prev.v * f + cur.v * (1 - f));

      du = du * (1 - f) + lastDu * f;
      dv = dv * (1 - f) + lastDv * f;
      const len2 = Math.hypot(du, dv);
      du /= len2;
      dv /= len2;

      return { temperature, tint: (uu * du + vv * dv) * TINT_SCALE };
    }

    lastDt = dt;
    lastDu = du;
    lastDv = dv;
  }
  // Unreachable: index 30 always returns.
  throw new Error('Robertson search did not terminate');
}

/** Temperature (Kelvin) and tint to CIE 1931 xy chromaticity. */
export function temperatureTintToXY({ temperature, tint }: TemperatureTint): XY {
  const r = 1e6 / temperature;
  const offset = tint * (1 / TINT_SCALE);

  for (let index = 0; index <= 29; index++) {
    const lo = line(index);
    const hi = line(index + 1);
    if (r < hi.r || index === 29) {
      const f = (hi.r - r) / (hi.r - lo.r);

      let u = lo.u * f + hi.u * (1 - f);
      let v = lo.v * f + hi.v * (1 - f);

      let uu1 = 1;
      let vv1 = lo.t;
      let uu2 = 1;
      let vv2 = hi.t;
      const len1 = Math.hypot(1, vv1);
      const len2 = Math.hypot(1, vv2);
      uu1 /= len1;
      vv1 /= len1;
      uu2 /= len2;
      vv2 /= len2;

      let uu3 = uu1 * f + uu2 * (1 - f);
      let vv3 = vv1 * f + vv2 * (1 - f);
      const len3 = Math.hypot(uu3, vv3);
      uu3 /= len3;
      vv3 /= len3;

      u += uu3 * offset;
      v += vv3 * offset;

      const d = u - 4 * v + 2;
      return { x: (1.5 * u) / d, y: v / d };
    }
  }
  throw new Error('Robertson search did not terminate');
}
