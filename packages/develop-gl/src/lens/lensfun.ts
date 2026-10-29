import type { LensShotInfo } from '@ee/contracts';
import database from '../../data/lensfun.json';

/**
 * The Lensfun lens database (pruned to Nikon lenses, see `scripts/update-lensfun.ts`) and the
 * calibration models, written from Lensfun's documentation. No Lensfun code is used.
 *
 * Distortion maps a corrected radius to the recorded one (`r_d = r_u * (...)` in the docs);
 * `u` below is the radius in units of half the short edge of the frame the lens was calibrated on.
 */

type Row = (number | string | undefined | null)[];

export interface LensfunLens {
  maker: string;
  model: string;
  mounts: string[];
  crop?: number;
  aspect?: number;
  type?: string;
  focal?: [number | null, number | null];
  center?: [number | null, number | null];
  distortion: Row[];
  tca: Row[];
  vignetting: Row[];
}

interface LensfunData {
  version: number;
  mounts: Record<string, string[]>;
  cameras: { maker: string; model: string; mount: string; crop: number }[];
  lenses: LensfunLens[];
}

export const LENSFUN = database as unknown as LensfunData;

/** The lens as a person names it: Nikon's own names already say Nikkor, other makers get their name in front. */
export const lensDisplayName = (lens: LensfunLens): string =>
  lens.maker === 'Nikon' || lens.model.toLowerCase().includes(lens.maker.toLowerCase())
    ? lens.model
    : `${lens.maker} ${lens.model}`;

/** Stable identity of a lens in the database, used in `LensProfileChoice`. */
export const lensfunKey = (lens: LensfunLens): string =>
  `${lens.maker}|${lens.model}|${lens.crop ?? 1}`;

const byKey = new Map(LENSFUN.lenses.map((lens) => [lensfunKey(lens), lens]));
export const lensfunByKey = (key: string): LensfunLens | undefined => byKey.get(key);

const normalizeName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/nikon corporation|nikkor|nikon/g, ' ')
    .replace(/[ƒ×]/g, 'f')
    .replace(/f\s*\//g, 'f')
    .replace(/[()[\],:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const nameTokens = (name: string): string[] => normalizeName(name).split(' ').filter(Boolean);

/** How well the EXIF lens name fits a database lens: 0 when numbers (focal lengths, apertures) disagree. */
export function nameScore(exifName: string, lensName: string): number {
  const a = new Set(nameTokens(exifName));
  const b = new Set(nameTokens(lensName));
  const digits = (set: Set<string>): string =>
    [...set]
      .filter((token) => /\d/.test(token))
      .sort()
      .join(' ');
  if (digits(a) !== digits(b)) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

export function cameraEntry(shot: LensShotInfo): LensfunData['cameras'][number] | undefined {
  if (!shot.cameraModel) return undefined;
  const wanted = shot.cameraModel.trim().toLowerCase();
  return LENSFUN.cameras.find((camera) => camera.model.toLowerCase() === wanted);
}

/** Mount of the body: Lensfun's entry, else the Z mount for a Z body. */
function cameraMount(shot: LensShotInfo): string | undefined {
  const entry = cameraEntry(shot);
  if (entry) return entry.mount;
  return /\bz\s?\d/i.test(shot.cameraModel ?? '') ? 'Nikon Z' : undefined;
}

/** Whether the lens fits the body, directly or through an adapter Lensfun lists. */
function fitsCamera(lens: LensfunLens, mount: string | undefined): boolean {
  if (mount === undefined) return true;
  const compat = LENSFUN.mounts[mount] ?? [];
  return lens.mounts.some((m) => m === mount || compat.includes(m));
}

const rectilinear = (lens: LensfunLens): boolean => (lens.type ?? 'rectilinear') === 'rectilinear';

export interface LensfunChoice {
  key: string;
  name: string;
  /** True when this is the lens the file names. */
  matched: boolean;
}

/** The best database lens for the EXIF lens name, or none. Ties go to the one covering the focal length. */
export function matchLensfun(shot: LensShotInfo): LensfunLens | undefined {
  if (!shot.lensModel) return undefined;
  const mount = cameraMount(shot);
  let best: { lens: LensfunLens; score: number } | undefined;
  for (const lens of LENSFUN.lenses) {
    if (!rectilinear(lens) || !fitsCamera(lens, mount)) continue;
    const score = nameScore(shot.lensModel, `${lens.maker} ${lens.model}`);
    // Calibrated on a body of the same format when there is a choice (DX lenses on a DX body).
    const sameFormat = Math.abs((lens.crop ?? 1) - (photoCropFactor(shot) ?? 1)) < 0.2 ? 0.01 : 0;
    if (score >= 0.6 && (!best || score + sameFormat > best.score)) {
      best = { lens, score: score + sameFormat };
    }
  }
  return best?.lens;
}

/** Every lens that fits the body, the matched one first. */
export function lensfunChoices(shot: LensShotInfo): LensfunChoice[] {
  const mount = cameraMount(shot);
  const matched = matchLensfun(shot);
  const choices = LENSFUN.lenses
    .filter((lens) => rectilinear(lens) && fitsCamera(lens, mount) && lens.distortion.length > 0)
    .map((lens) => ({
      key: lensfunKey(lens),
      name: lensDisplayName(lens),
      matched: lens === matched,
    }));
  choices.sort((a, b) => Number(b.matched) - Number(a.matched) || a.name.localeCompare(b.name));
  return choices;
}

/**
 * Crop factor of the frame the photo was taken in: the body's (Lensfun's entry), or from the 35 mm
 * equivalent focal length when that differs by more than 10% (a DX lens on an FX body crops).
 */
export function photoCropFactor(shot: LensShotInfo): number | undefined {
  const entry = cameraEntry(shot);
  const ratio =
    shot.focalLength && shot.focalLength35 && shot.focalLength > 0
      ? shot.focalLength35 / shot.focalLength
      : undefined;
  if (entry && ratio !== undefined && Math.abs(ratio / entry.crop - 1) > 0.1) return ratio;
  return entry?.crop ?? ratio;
}

// --- calibration interpolation -----------------------------------------------------------------

/** Lensfun's cubic Hermite step between `y2` and `y3` with tangents from the neighbours. */
function hermite(y1: number, y2: number, y3: number, y4: number, t: number): number {
  const tg2 = (y3 - y1) * 0.5;
  const tg3 = (y4 - y2) * 0.5;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    y2 * (2 * t3 - 3 * t2 + 1) + tg2 * (t3 - 2 * t2 + t) + y3 * (-2 * t3 + 3 * t2) + tg3 * (t3 - t2)
  );
}

/**
 * Interpolates calibration parameters in focal length. `rows` are sorted by focal length,
 * `scaled[i]` flags the parameters that are multiplied by their focal length before the
 * interpolation and divided by the photo's after it (Lensfun does this for the distortion
 * coefficients and the CA terms). Held at the nearest row outside the calibrated range.
 */
export function interpolateInFocalLength(
  rows: { focal: number; values: number[] }[],
  focal: number,
  scaled: readonly boolean[],
): number[] | undefined {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return undefined;
  if (rows.length === 1 || focal <= first.focal) return [...first.values];
  if (focal >= last.focal) return [...last.values];
  let i = 1;
  while (i < rows.length - 1 && (rows[i]?.focal ?? Infinity) <= focal) i++;
  const r2 = rows[i - 1];
  const r3 = rows[i];
  if (!r2 || !r3) return undefined;
  const r1 = rows[i - 2] ?? r2;
  const r4 = rows[i + 1] ?? r3;
  const t = (focal - r2.focal) / (r3.focal - r2.focal);
  const value = (row: { focal: number; values: number[] }, k: number): number =>
    (row.values[k] ?? 0) * (scaled[k] ? row.focal : 1);
  return r2.values.map((_, k) => {
    const h = hermite(value(r1, k), value(r2, k), value(r3, k), value(r4, k), t);
    return scaled[k] ? h / focal : h;
  });
}

/** Inverse distance weighting over (focal length, 4 / f-number, 0.1 / focus distance), as Lensfun does. */
export function interpolateVignetting(
  rows: Row[],
  focal: number,
  aperture: number,
  distance: number,
): [number, number, number] | undefined {
  const entries = rows
    .map((row) => ({
      focal: Number(row[0]),
      aperture: Number(row[1]),
      distance: Number(row[2]),
      k: [Number(row[3]), Number(row[4]), Number(row[5])] as [number, number, number],
    }))
    .filter((e) => Number.isFinite(e.focal) && Number.isFinite(e.aperture) && e.aperture > 0);
  if (entries.length === 0) return undefined;
  const focals = entries.map((e) => e.focal);
  const span = Math.max(...focals) - Math.min(...focals) || 1;
  const sum: [number, number, number] = [0, 0, 0];
  let weights = 0;
  let nearest = Infinity;
  for (const e of entries) {
    const df = (e.focal - focal) / span;
    const da = 4 / e.aperture - 4 / aperture;
    const dd = 0.1 / e.distance - 0.1 / distance;
    const d = Math.sqrt(df * df + da * da + dd * dd);
    nearest = Math.min(nearest, d);
    if (d < 1e-4) return e.k;
    const w = 1 / d ** 3.5;
    weights += w;
    for (let i = 0; i < 3; i++) sum[i] = (sum[i] ?? 0) + w * e.k[i]!;
  }
  // Lensfun applies nothing when no calibration is within reach of the photo's settings.
  if (nearest > 1) return undefined;
  return [sum[0]! / weights, sum[1]! / weights, sum[2]! / weights];
}

// --- profile ----------------------------------------------------------------------------------

/** A lens correction reduced to radial polynomials in pixels; see `model.ts`. */
export interface LensProfile {
  /** `builtin` or `lensfun:<key>`. */
  id: string;
  name: string;
  source: 'builtin' | 'lensfun';
  /** The camera says the lens needs the correction (only built-in data). */
  required: boolean;
  centre: [number, number];
  distortion: { coefficients: number[]; unit: number } | null;
  ca: { red: number[]; blue: number[]; unit: number; atSource: boolean } | null;
  vignette: { numerator: number[]; denominator: number[]; unit: number } | null;
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function focalRows(rows: Row[]): { focal: number; row: Row }[] {
  return rows
    .map((row) => ({ focal: num(row[0], NaN), row }))
    .filter((r) => Number.isFinite(r.focal))
    .sort((a, b) => a.focal - b.focal);
}

/** Distortion polynomial of the photo's focal length. */
function lensfunDistortion(rows: Row[], focal: number | undefined): number[] | undefined {
  const sorted = focalRows(rows);
  if (sorted.length === 0) return undefined;
  if (sorted.length > 1 && focal === undefined) return undefined;
  // Rows of one model; a lens with mixed models uses its most common one.
  const models = sorted.map((r) => String(r.row[1]));
  const model = models.sort(
    (a, b) => models.filter((m) => m === b).length - models.filter((m) => m === a).length,
  )[0];
  const same = sorted.filter((r) => r.row[1] === model);
  const params = same.map((r) => ({ focal: r.focal, values: r.row.slice(2).map((v) => num(v)) }));
  const scaled = params[0]?.values.map(() => true) ?? [];
  const k = interpolateInFocalLength(params, focal ?? params[0]?.focal ?? 1, scaled);
  if (!k) return undefined;
  if (model === 'p3') return [1 - (k[0] ?? 0), 0, k[0] ?? 0];
  if (model === 'p5') return [1, 0, k[0] ?? 0, 0, k[1] ?? 0];
  const [a = 0, b = 0, c = 0] = k;
  return [1 - a - b - c, c, b, a];
}

/** Red and blue radius ratio polynomials (ascending, `CA_TERMS` long). */
function lensfunCa(
  rows: Row[],
  focal: number | undefined,
): { red: number[]; blue: number[] } | undefined {
  const sorted = focalRows(rows);
  if (sorted.length === 0) return undefined;
  if (sorted.length > 1 && focal === undefined) return undefined;
  // Normalise every row to poly3: [vr, vb, br, bb, cr, cb]; the v terms are not scaled by focal length.
  const params = sorted.map((r) => ({
    focal: r.focal,
    values:
      r.row[1] === 'lin'
        ? [num(r.row[2], 1), num(r.row[3], 1), 0, 0, 0, 0]
        : r.row.slice(2, 8).map((v, i) => num(v, i < 2 ? 1 : 0)),
  }));
  const k = interpolateInFocalLength(params, focal ?? params[0]?.focal ?? 1, [
    false,
    false,
    true,
    true,
    true,
    true,
  ]);
  if (!k) return undefined;
  const [vr = 1, vb = 1, br = 0, bb = 0, cr = 0, cb = 0] = k;
  return { red: [vr, cr, br, 0], blue: [vb, cb, bb, 0] };
}

/** The photo frame and the frame a lens was calibrated on, as pixel units of the radius. */
function lensfunUnits(
  lens: LensfunLens,
  shot: LensShotInfo,
  width: number,
  height: number,
): { distortion: number; vignette: number } {
  const diagonal = Math.hypot(width, height);
  const photoCrop = photoCropFactor(shot) ?? lens.crop ?? 1;
  const ratio = photoCrop / (lens.crop ?? 1);
  const aspect = lens.aspect ?? 1.5;
  return {
    distortion: (diagonal * ratio) / (2 * Math.sqrt(aspect * aspect + 1)),
    vignette: (diagonal * ratio) / 2,
  };
}

export function lensfunProfile(
  lens: LensfunLens,
  shot: LensShotInfo,
  width: number,
  height: number,
): LensProfile {
  const units = lensfunUnits(lens, shot, width, height);
  const focal = shot.focalLength;
  const distortion = lensfunDistortion(lens.distortion, focal);
  const ca = lensfunCa(lens.tca, focal);
  const k =
    lens.vignetting.length > 0 && focal !== undefined && shot.fNumber !== undefined
      ? interpolateVignetting(lens.vignetting, focal, shot.fNumber, shot.focusDistance ?? 1000)
      : undefined;
  const halfShort = Math.min(width, height) / 2;
  return {
    id: `lensfun:${lensfunKey(lens)}`,
    name: lensDisplayName(lens),
    source: 'lensfun',
    required: false,
    centre: [
      width / 2 + num(lens.center?.[0]) * halfShort,
      height / 2 + num(lens.center?.[1]) * halfShort,
    ],
    distortion: distortion ? { coefficients: distortion, unit: units.distortion } : null,
    ca: ca ? { ...ca, unit: units.distortion, atSource: true } : null,
    vignette: k
      ? {
          numerator: [1],
          denominator: [1, 0, k[0], 0, k[1], 0, k[2]],
          unit: units.vignette,
        }
      : null,
  };
}
