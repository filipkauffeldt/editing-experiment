import type { BuiltinLensCorrection, EditParams, LensShotInfo } from '@ee/contracts';
import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import {
  CA_TERMS,
  DISTORTION_TERMS,
  NO_LENS,
  VIGNETTE_DENOMINATOR_TERMS,
  VIGNETTE_NUMERATOR_TERMS,
  manualDistortionConstant,
  manualVignette,
  polynomial,
  type LensUniforms,
} from './model';
import {
  lensfunByKey,
  lensfunChoices,
  lensfunProfile,
  matchLensfun,
  type LensProfile,
} from './lensfun';

/** Measured lateral CA (`AutoLateralCA`): red and blue radius over green's, `q` over the half diagonal. */
export interface MeasuredCa {
  red: number[];
  blue: number[];
}

/** What the lens resolution needs of the image. */
export interface LensImage {
  width: number;
  height: number;
  lens?: LensShotInfo | undefined;
}

const pad = (values: readonly number[], size: number): number[] =>
  Array.from({ length: size }, (_, i) => values[i] ?? 0);

const slider = (params: EditParams, name: SliderParam): number => {
  const spec = SLIDER_SPECS[name];
  const raw = params[name];
  const value = raw === undefined || !Number.isFinite(raw) ? (spec.neutral ?? 0) : raw;
  return Math.min(spec.max, Math.max(spec.min, value));
};

/** The camera's own correction as a profile for an image of `width` x `height`. */
export function builtinProfile(
  builtin: BuiltinLensCorrection,
  width: number,
  height: number,
): LensProfile {
  const unit = Math.max(1e-6, builtin.unit * (Math.hypot(width, height) / 2));
  return {
    id: 'builtin',
    name: builtin.source,
    source: 'builtin',
    required: builtin.required,
    centre: [width / 2 + builtin.centre.x * width, height / 2 + builtin.centre.y * height],
    distortion: builtin.distortion ? { coefficients: builtin.distortion, unit } : null,
    ca:
      builtin.red && builtin.blue
        ? { red: builtin.red, blue: builtin.blue, unit, atSource: false }
        : null,
    vignette: builtin.vignetting ? { numerator: builtin.vignetting, denominator: [1], unit } : null,
  };
}

/**
 * The geometry of the camera's own embedded preview JPEG: Nikon applies its distortion correction
 * (the file's built-in profile, at 100 %) to the preview whenever the camera's distortion control
 * was on, which is exactly when a built-in profile exists. Null for a picture without one, whose
 * preview is as recorded.
 */
export function previewGeometry(image: LensImage): LensUniforms | null {
  const builtin = image.lens?.builtin;
  if (!builtin) return null;
  const profile = builtinProfile(builtin, image.width, image.height);
  if (!profile.distortion) return null;
  const frame = {
    x: image.width / 2,
    y: image.height / 2,
    radius: Math.hypot(image.width, image.height) / 2,
  };
  return {
    ...NO_LENS,
    active: true,
    geometry: true,
    centre: profile.centre,
    frame,
    distortion: {
      coefficients: pad(profile.distortion.coefficients, DISTORTION_TERMS),
      unit: profile.distortion.unit,
    },
  };
}

/**
 * The profile the settings pick: the stored choice, else the camera's own data, else the best
 * Lensfun match for the lens name. Null when nothing fits.
 */
export function selectProfile(
  shot: LensShotInfo | undefined,
  choice: string | undefined,
  width: number,
  height: number,
): LensProfile | null {
  if (!shot) return null;
  if (choice?.startsWith('lensfun:')) {
    const lens = lensfunByKey(choice.slice('lensfun:'.length));
    if (lens) return lensfunProfile(lens, shot, width, height);
  }
  if (
    shot.builtin &&
    (choice === undefined || choice === 'builtin' || choice.startsWith('lensfun:'))
  ) {
    // An unknown Lensfun key (an older database) falls back to the camera's data.
    return builtinProfile(shot.builtin, width, height);
  }
  const matched = matchLensfun(shot);
  return matched ? lensfunProfile(matched, shot, width, height) : null;
}

/**
 * Smallest zoom of the distortion map that keeps every corrected edge sample inside the picture
 * (1 when it already does), so a pincushion correction never pulls in empty canvas.
 */
export function fitScale(
  coefficients: readonly number[],
  unit: number,
  centre: readonly [number, number],
  width: number,
  height: number,
): number {
  let scale = 1;
  const steps = 128;
  for (let i = 0; i < steps * 4; i++) {
    const side = Math.floor(i / steps);
    const t = (i % steps) / steps;
    const x = side === 0 ? t * width : side === 2 ? (1 - t) * width : side === 1 ? width : 0;
    const y = side === 1 ? t * height : side === 3 ? (1 - t) * height : side === 0 ? 0 : height;
    const dx = x - centre[0];
    const dy = y - centre[1];
    const g = polynomial(coefficients, Math.hypot(dx, dy) / unit);
    const vx = dx * g;
    const vy = dy * g;
    // Half a pixel of slack so a profile that fits exactly does not zoom by rounding noise.
    if (vx > 0) scale = Math.min(scale, (width - 0.5 - centre[0]) / vx);
    if (vx < 0) scale = Math.min(scale, (0.5 - centre[0]) / vx);
    if (vy > 0) scale = Math.min(scale, (height - 0.5 - centre[1]) / vy);
    if (vy < 0) scale = Math.min(scale, (0.5 - centre[1]) / vy);
  }
  return Math.max(0.5, scale);
}

export interface LensResolution {
  uniforms: LensUniforms;
  /** The profile that applies (null when the profile switch is off or nothing matches). */
  profile: LensProfile | null;
}

/** Whether the profile corrections are on: the explicit switch, else the camera's "required". */
export const profileEnabled = (params: EditParams, shot: LensShotInfo | undefined): boolean =>
  params.LensProfileEnable ?? shot?.builtin?.required ?? false;

/** Resolves the lens settings for one image into what the shader and the CPU reference evaluate. */
export function resolveLens(
  image: LensImage,
  params: EditParams,
  measuredCa?: MeasuredCa | null,
): LensResolution {
  const { width, height } = image;
  const profile = profileEnabled(params, image.lens)
    ? selectProfile(image.lens, params.LensProfileChoice, width, height)
    : null;

  const frame = { x: width / 2, y: height / 2, radius: Math.hypot(width, height) / 2 };
  const centre: [number, number] = profile ? profile.centre : [frame.x, frame.y];

  const distortionAmount = slider(params, 'LensProfileDistortionScale') / 100;
  let distortion: LensUniforms['distortion'] = null;
  if (profile?.distortion && distortionAmount > 0) {
    const source = pad(profile.distortion.coefficients, DISTORTION_TERMS);
    // 1 + amount * (g - 1)
    const blended = source.map(
      (c, i) => distortionAmount * c + (i === 0 ? 1 - distortionAmount : 0),
    );
    const unit = profile.distortion.unit;
    const zoom = fitScale(blended, unit, centre, width, height);
    distortion = { coefficients: blended.map((c) => c * zoom), unit };
  }

  const manual = manualDistortionConstant(slider(params, 'LensManualDistortionAmount'));

  let ca: LensUniforms['ca'] = null;
  if (params.AutoLateralCA === true && measuredCa) {
    ca = {
      red: pad(measuredCa.red, CA_TERMS),
      blue: pad(measuredCa.blue, CA_TERMS),
      unit: frame.radius,
      // The measurement is of the recorded picture, so it is a function of the recorded radius.
      atSource: true,
    };
  } else if (profile?.ca) {
    ca = {
      red: pad(profile.ca.red, CA_TERMS),
      blue: pad(profile.ca.blue, CA_TERMS),
      unit: profile.ca.unit,
      atSource: profile.ca.atSource,
    };
  }

  const vignetteAmount = slider(params, 'LensProfileVignettingScale') / 100;
  const vignette: LensUniforms['vignette'] =
    profile?.vignette && vignetteAmount > 0
      ? {
          numerator: pad(profile.vignette.numerator, VIGNETTE_NUMERATOR_TERMS),
          denominator: pad(profile.vignette.denominator, VIGNETTE_DENOMINATOR_TERMS),
          unit: profile.vignette.unit,
          exponent: vignetteAmount,
        }
      : null;

  const manualGain = manualVignette(
    slider(params, 'VignetteAmount'),
    slider(params, 'VignetteMidpoint'),
  );
  const geometry = distortion !== null || manual !== 0 || ca !== null;
  const active = geometry || vignette !== null || manualGain !== null;
  if (!active) return { uniforms: NO_LENS, profile };
  return {
    uniforms: {
      active,
      geometry,
      centre,
      frame,
      distortion,
      manualDistortion: manual,
      ca,
      vignette,
      manualVignette: manualGain,
    },
    profile,
  };
}

// --- the panel ---------------------------------------------------------------------------------

export interface LensPanelChoice {
  /** The value stored in `LensProfileChoice`; `''` is automatic. */
  value: string;
  label: string;
}

export interface LensPanelState {
  /** The photo has lens data to correct with (a camera profile or a lens name). */
  available: boolean;
  /** The switch as it currently counts (explicit setting, else the camera's default). */
  enabled: boolean;
  /** The camera marks the correction as needed. */
  required: boolean;
  /** The profile in use (or that would be used), for display. */
  profileName: string | undefined;
  /** What the profile corrects, for display: `distortion`, `vignetting`, `chromatic aberration`. */
  corrects: string[];
  choices: LensPanelChoice[];
}

/** What the Lens Corrections panel shows for a photo and its settings. */
export function describeLens(image: LensImage, params: EditParams): LensPanelState {
  const shot = image.lens;
  const selected = selectProfile(shot, params.LensProfileChoice, image.width, image.height);
  const choices: LensPanelChoice[] = [{ value: '', label: 'Automatic' }];
  if (shot?.builtin) choices.push({ value: 'builtin', label: 'Camera (Nikon built-in)' });
  if (shot) {
    for (const choice of lensfunChoices(shot)) {
      choices.push({
        value: `lensfun:${choice.key}`,
        label: `${choice.matched ? '★ ' : ''}${choice.name} (Lensfun)`,
      });
    }
  }
  return {
    available: shot !== undefined && (shot.builtin !== undefined || selected !== null),
    enabled: profileEnabled(params, shot),
    required: shot?.builtin?.required ?? false,
    profileName: selected
      ? selected.source === 'builtin'
        ? 'Camera (Nikon built-in)'
        : `${selected.name} (Lensfun)`
      : undefined,
    corrects: selected
      ? [
          ...(selected.distortion ? ['distortion'] : []),
          ...(selected.vignette ? ['vignetting'] : []),
          ...(selected.ca ? ['chromatic aberration'] : []),
        ]
      : [],
    choices,
  };
}
