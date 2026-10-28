import type { EditParams } from '@ee/contracts';
import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { luminance } from '../ops';

/**
 * Camera Calibration, ported from RAWmakase (`develop/calibration.rs`, MIT).
 * Its measured matrices change colour differences while preserving neutrals:
 * a row gains `a[r]`, `-(a[r] + b[r])` and `b[r]` in its three columns, so a
 * grey (r = g = b) is left exactly as it was.
 *
 * RAWmakase measured these on Camera Raw 18.7's dense synthetic chart. They are
 * interpolated between the measured slider positions and summed when several
 * sliders are active, exactly as there.
 */

interface Adjustment {
  a: [number, number, number];
  b: [number, number, number];
}

const ZERO: Adjustment = { a: [0, 0, 0], b: [0, 0, 0] };

const lerp = (x: Adjustment, y: Adjustment, t: number): Adjustment => ({
  a: [0, 1, 2].map((r) => x.a[r]! + (y.a[r]! - x.a[r]!) * t) as [number, number, number],
  b: [0, 1, 2].map((r) => x.b[r]! + (y.b[r]! - x.b[r]!) * t) as [number, number, number],
});

const A = (a: [number, number, number], b: [number, number, number]): Adjustment => ({ a, b });

/** Per primary (red, green, blue) and slider (Hue, Saturation), at -100, -50, +50, +100. */
const MEASURED: Adjustment[][][] = [
  [
    [
      A([0.0257, -0.1685, 0.2119], [0.0985, -0.0398, -0.2825]),
      A([0.004, -0.0857, 0.1019], [0.0506, -0.0145, -0.1443]),
      A([-0.0446, 0.0866, -0.1087], [-0.0354, 0.0326, 0.1309]),
      A([-0.0738, 0.1752, -0.2156], [-0.0786, 0.0518, 0.2664]),
    ],
    [
      A([-0.196, 0.2131, 0.2123], [0.0576, 0.0569, -0.3492]),
      A([-0.1063, 0.1054, 0.1039], [0.0329, 0.0339, -0.1763]),
      A([0.0643, -0.1029, -0.1085], [-0.0169, -0.0148, 0.1614]),
      A([0.1455, -0.206, -0.2114], [-0.0375, -0.0406, 0.3279]),
    ],
  ],
  [
    [
      A([-0.2924, 0.0345, -0.0296], [-0.1393, 0.0177, 0.3133]),
      A([-0.155, 0.016, -0.0179], [-0.0669, 0.015, 0.1557]),
      A([0.1194, -0.0144, 0.0137], [0.081, 0.003, -0.1671]),
      A([0.2611, -0.0265, 0.0288], [0.1568, -0.005, -0.3291]),
    ],
    [
      A([-0.3696, 0.0381, 0.0365], [0.0095, 0.0117, -0.3949]),
      A([-0.192, 0.0186, 0.0163], [0.0087, 0.0112, -0.1985]),
      A([0.1531, -0.0175, -0.0208], [0.0067, 0.0082, 0.1843]),
      A([0.3272, -0.0335, -0.0377], [0.0124, 0.0064, 0.3774]),
    ],
  ],
  [
    [
      A([0.3445, -0.0652, 0.0068], [-0.6632, 0.3938, -0.0512]),
      A([0.1616, -0.0324, 0.0038], [-0.3225, 0.1996, -0.0282]),
      A([-0.2003, 0.0306, -0.0067], [0.3409, -0.1808, 0.0048]),
      A([-0.3802, 0.0665, -0.0078], [0.6706, -0.3789, 0.0161]),
    ],
    [
      A([-0.403, 0.0028, 0.0029], [0.3526, 0.3545, -0.0531]),
      A([-0.2086, 0.0006, 0], [0.1795, 0.1817, -0.0305]),
      A([0.1706, 0.0007, -0.0031], [-0.1633, -0.1654, 0.0116]),
      A([0.3629, -0.0002, -0.0044], [-0.3399, -0.3308, 0.0325]),
    ],
  ],
];

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function measured(primary: number, kind: number, value: number): Adjustment {
  const knots = [
    [-1, MEASURED[primary]![kind]![0]!],
    [-0.5, MEASURED[primary]![kind]![1]!],
    [0, ZERO],
    [0.5, MEASURED[primary]![kind]![2]!],
    [1, MEASURED[primary]![kind]![3]!],
  ] as const;
  const v = Math.min(1, Math.max(-1, value));
  let i = 0;
  for (let k = 0; k < 4; k++) if (knots[k]![0] <= v) i = k;
  const [x0, a0] = knots[i]!;
  const [x1, a1] = knots[i + 1]!;
  return lerp(a0, a1, x1 === x0 ? 0 : (v - x0) / (x1 - x0));
}

/** A resolved calibration: 3x3 row-major matrix plus the shadow tint amount (-1..1). */
export interface Calibration {
  matrix: number[];
  shadow: number;
  active: boolean;
}

const value = (params: EditParams, name: SliderParam): number => {
  const raw = params[name];
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  return Math.min(SLIDER_SPECS[name].max, Math.max(SLIDER_SPECS[name].min, raw)) / 100;
};

/** Builds the measured calibration matrix and shadow tint from `EditParams`. */
export function resolveCalibration(params: EditParams): Calibration {
  const primaries: [number, number][] = [
    [value(params, 'RedHue'), value(params, 'RedSaturation')],
    [value(params, 'GreenHue'), value(params, 'GreenSaturation')],
    [value(params, 'BlueHue'), value(params, 'BlueSaturation')],
  ];
  const shadow = value(params, 'ShadowTint');
  const matrix = [...IDENTITY];
  let active = shadow !== 0;
  for (let primary = 0; primary < 3; primary++) {
    for (let kind = 0; kind < 2; kind++) {
      const v = primaries[primary]![kind]!;
      if (v === 0) continue;
      active = true;
      const { a, b } = measured(primary, kind, v);
      for (let r = 0; r < 3; r++) {
        matrix[r * 3] = matrix[r * 3]! + a[r]!;
        matrix[r * 3 + 1] = matrix[r * 3 + 1]! - (a[r]! + b[r]!);
        matrix[r * 3 + 2] = matrix[r * 3 + 2]! + b[r]!;
      }
    }
  }
  return { matrix, shadow, active };
}

/** Applies calibration to linear RGB (same space as the camera matrix output). */
export function applyCalibration(
  rgb: [number, number, number],
  calibration: Calibration,
): [number, number, number] {
  const m = calibration.matrix;
  let r = m[0]! * rgb[0] + m[1]! * rgb[1] + m[2]! * rgb[2];
  let g = m[3]! * rgb[0] + m[4]! * rgb[1] + m[5]! * rgb[2];
  let b = m[6]! * rgb[0] + m[7]! * rgb[1] + m[8]! * rgb[2];
  if (calibration.shadow !== 0) {
    const y = Math.max(luminance(r, g, b), 0);
    const amount = Math.abs(calibration.shadow) * y * Math.exp(-6 * y);
    const direction = calibration.shadow > 0 ? [0.116, -0.189, -0.002] : [-0.331, 0.029, -0.152];
    r += amount * direction[0]!;
    g += amount * direction[1]!;
    b += amount * direction[2]!;
  }
  return [r, g, b];
}
