import { SLIDER_SPECS, type SliderParam, type VignetteStyle } from '@ee/contracts';
import { useState, type ReactNode } from 'react';
import { activePhoto, paramsForPhoto, sectionEnabled } from '../store';
import { asShotTrackPosition, temperatureToTrack, trackToTemperature } from '../temperature-scale';
import { useAppState, useAppStore } from '../store-context';
import { CloseIcon, PlusIcon } from './icons';
import { Panel } from './Panel';
import { Button } from './ui/Button';
import { Select } from './ui/Field';
import { PanelSection } from './ui/PanelSection';
import { Slider as SliderControl } from './ui/Slider';
import styles from './DevelopPanel.module.css';

const LABELS: Record<SliderParam, string> = {
  Exposure2012: 'Exposure',
  Temperature: 'Temperature',
  Tint: 'Tint',
  Contrast2012: 'Contrast',
  Highlights2012: 'Highlights',
  Shadows2012: 'Shadows',
  Whites2012: 'Whites',
  Blacks2012: 'Blacks',
  Vibrance: 'Vibrance',
  Saturation: 'Saturation',
  HueAdjustmentRed: 'Red',
  SaturationAdjustmentRed: 'Red',
  LuminanceAdjustmentRed: 'Red',
  HueAdjustmentOrange: 'Orange',
  SaturationAdjustmentOrange: 'Orange',
  LuminanceAdjustmentOrange: 'Orange',
  HueAdjustmentYellow: 'Yellow',
  SaturationAdjustmentYellow: 'Yellow',
  LuminanceAdjustmentYellow: 'Yellow',
  HueAdjustmentGreen: 'Green',
  SaturationAdjustmentGreen: 'Green',
  LuminanceAdjustmentGreen: 'Green',
  HueAdjustmentAqua: 'Aqua',
  SaturationAdjustmentAqua: 'Aqua',
  LuminanceAdjustmentAqua: 'Aqua',
  HueAdjustmentBlue: 'Blue',
  SaturationAdjustmentBlue: 'Blue',
  LuminanceAdjustmentBlue: 'Blue',
  HueAdjustmentPurple: 'Purple',
  SaturationAdjustmentPurple: 'Purple',
  LuminanceAdjustmentPurple: 'Purple',
  HueAdjustmentMagenta: 'Magenta',
  SaturationAdjustmentMagenta: 'Magenta',
  LuminanceAdjustmentMagenta: 'Magenta',
  ColorGradeShadowHue: 'Hue',
  ColorGradeShadowSat: 'Saturation',
  ColorGradeShadowLum: 'Luminance',
  ColorGradeMidtoneHue: 'Hue',
  ColorGradeMidtoneSat: 'Saturation',
  ColorGradeMidtoneLum: 'Luminance',
  ColorGradeHighlightHue: 'Hue',
  ColorGradeHighlightSat: 'Saturation',
  ColorGradeHighlightLum: 'Luminance',
  ColorGradeGlobalHue: 'Hue',
  ColorGradeGlobalSat: 'Saturation',
  ColorGradeGlobalLum: 'Luminance',
  ColorGradeBlending: 'Blending',
  ColorGradeBalance: 'Balance',
  RedHue: 'Red Hue',
  RedSaturation: 'Red Saturation',
  GreenHue: 'Green Hue',
  GreenSaturation: 'Green Saturation',
  BlueHue: 'Blue Hue',
  BlueSaturation: 'Blue Saturation',
  ShadowTint: 'Shadow Tint',
  ParametricShadows: 'Shadows',
  ParametricDarks: 'Darks',
  ParametricLights: 'Lights',
  ParametricHighlights: 'Highlights',
  ParametricShadowSplit: 'Shadow Split',
  ParametricMidtoneSplit: 'Midtone Split',
  ParametricHighlightSplit: 'Highlight Split',
  PostCropVignetteAmount: 'Amount',
  PostCropVignetteMidpoint: 'Midpoint',
  PostCropVignetteRoundness: 'Roundness',
  PostCropVignetteFeather: 'Feather',
  PostCropVignetteHighlights: 'Highlights',
  GrainAmount: 'Amount',
  GrainSize: 'Size',
  GrainFrequency: 'Frequency',
  Texture: 'Texture',
  Clarity2012: 'Clarity',
  Dehaze: 'Dehaze',
  Sharpness: 'Amount',
  SharpenRadius: 'Radius',
  SharpenDetail: 'Detail',
  SharpenEdgeMasking: 'Masking',
  LuminanceSmoothing: 'Luminance',
  LuminanceNoiseReductionDetail: 'Luminance detail',
  LuminanceNoiseReductionContrast: 'Luminance contrast',
  ColorNoiseReduction: 'Color',
  ColorNoiseReductionDetail: 'Color detail',
  ColorNoiseReductionSmoothness: 'Color smoothness',
};

const BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;

const BASIC_GROUPS: { title: string; params: SliderParam[] }[] = [
  { title: 'White balance', params: ['Temperature', 'Tint'] },
  {
    title: 'Tone',
    params: [
      'Exposure2012',
      'Contrast2012',
      'Highlights2012',
      'Shadows2012',
      'Whites2012',
      'Blacks2012',
    ],
  },
  { title: 'Presence', params: ['Texture', 'Clarity2012', 'Dehaze', 'Vibrance', 'Saturation'] },
];

type MixerTab = 'Hue' | 'Saturation' | 'Luminance';

const MIXER_PARAMS: Record<MixerTab, SliderParam[]> = {
  Hue: BANDS.map((band) => `HueAdjustment${band}` as SliderParam),
  Saturation: BANDS.map((band) => `SaturationAdjustment${band}` as SliderParam),
  Luminance: BANDS.map((band) => `LuminanceAdjustment${band}` as SliderParam),
};

function Slider({ name }: { name: SliderParam }) {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const params = paramsForPhoto(state, photo);
  const spec = SLIDER_SPECS[name];
  const raw = params[name];
  // Raw files start at Lightroom's defaults (sharpening, colour noise reduction): that is the
  // slider's "untouched" position, where the tick sits and the fill starts.
  const start = (photo && state.editDefaults[photo.id]?.[name]) ?? spec.neutral ?? 0;
  const asShot = spec.neutral === null && raw === undefined;
  const isTemperature = name === 'Temperature';
  const position = isTemperature
    ? raw === undefined
      ? asShotTrackPosition()
      : temperatureToTrack(raw)
    : (raw ?? spec.neutral ?? 0);

  return (
    <SliderControl
      label={LABELS[name]}
      value={position}
      min={isTemperature ? 0 : spec.min}
      max={isTemperature ? 1000 : spec.max}
      step={isTemperature ? 1 : spec.step}
      neutral={isTemperature ? asShotTrackPosition() : start}
      display={asShot ? '' : (raw ?? spec.neutral ?? 0)}
      placeholder={asShot ? 'As shot' : undefined}
      numberMin={spec.min}
      numberMax={spec.max}
      numberStep={spec.step}
      tone={isTemperature ? 'temperature' : name === 'Tint' ? 'tint' : undefined}
      disabled={!photo}
      onRange={(value) => store.setSlider(name, isTemperature ? trackToTemperature(value) : value)}
      onNumber={(value) => store.setSlider(name, value)}
      onReset={() => store.resetSlider(name)}
    />
  );
}

/** A develop section whose header switch parks and restores its sliders. */
function Section({
  title,
  params,
  children,
}: {
  title: string;
  params: readonly SliderParam[];
  children: ReactNode;
}) {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  return (
    <PanelSection
      title={title}
      enabled={sectionEnabled(state, photo, title)}
      onEnabledChange={(enabled) => store.setSectionEnabled(title, params, enabled)}
    >
      {children}
    </PanelSection>
  );
}

function Group({ title, params }: { title: string; params: SliderParam[] }) {
  return (
    <Section title={title} params={params}>
      {params.map((name) => (
        <Slider key={name} name={name} />
      ))}
    </Section>
  );
}

const SHARPENING_PARAMS: SliderParam[] = [
  'Sharpness',
  'SharpenRadius',
  'SharpenDetail',
  'SharpenEdgeMasking',
];
const NOISE_PARAMS: SliderParam[] = [
  'LuminanceSmoothing',
  'LuminanceNoiseReductionDetail',
  'LuminanceNoiseReductionContrast',
  'ColorNoiseReduction',
  'ColorNoiseReductionDetail',
  'ColorNoiseReductionSmoothness',
];

function DetailSection() {
  return (
    <Section title="Detail" params={[...SHARPENING_PARAMS, ...NOISE_PARAMS]}>
      <div className={styles.subgroup}>
        <h4 className={styles.subgroupTitle}>Sharpening</h4>
        {SHARPENING_PARAMS.map((name) => (
          <Slider key={name} name={name} />
        ))}
      </div>
      <div className={styles.subgroup}>
        <h4 className={styles.subgroupTitle}>Noise reduction</h4>
        {NOISE_PARAMS.map((name) => (
          <Slider key={name} name={name} />
        ))}
      </div>
    </Section>
  );
}

function ColorMixerSection() {
  const [tab, setTab] = useState<MixerTab>('Hue');
  const all = Object.values(MIXER_PARAMS).flat();
  return (
    <Section title="Color Mixer" params={all}>
      <div className={styles.tabs} role="tablist" aria-label="Color Mixer">
        {(['Hue', 'Saturation', 'Luminance'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={`${styles.tab} ${tab === name ? styles.tabActive : ''}`}
            onClick={() => setTab(name)}
          >
            {name === 'Saturation' ? 'Sat' : name === 'Luminance' ? 'Lum' : name}
          </button>
        ))}
      </div>
      {MIXER_PARAMS[tab].map((name) => (
        <Slider key={name} name={name} />
      ))}
    </Section>
  );
}

const GRADING_PREFIXES = [
  ['Shadows', 'ColorGradeShadow'],
  ['Midtones', 'ColorGradeMidtone'],
  ['Highlights', 'ColorGradeHighlight'],
  ['Global', 'ColorGradeGlobal'],
] as const;

const GRADING_PARAMS: SliderParam[] = [
  ...GRADING_PREFIXES.flatMap(([, prefix]) =>
    (['Hue', 'Sat', 'Lum'] as const).map((part) => `${prefix}${part}` as SliderParam),
  ),
  'ColorGradeBlending',
  'ColorGradeBalance',
];

function ColorGradingSection() {
  return (
    <Section title="Color Grading" params={GRADING_PARAMS}>
      {GRADING_PREFIXES.map(([label, prefix]) => (
        <div key={label} className={styles.subgroup}>
          <h4 className={styles.subgroupTitle}>{label}</h4>
          <Slider name={`${prefix}Hue` as SliderParam} />
          <Slider name={`${prefix}Sat` as SliderParam} />
          <Slider name={`${prefix}Lum` as SliderParam} />
        </div>
      ))}
      <Slider name="ColorGradeBlending" />
      <Slider name="ColorGradeBalance" />
    </Section>
  );
}

const VIGNETTE_STYLES: VignetteStyle[] = ['Highlight Priority', 'Color Priority', 'Paint Overlay'];

const EFFECT_PARAMS: SliderParam[] = [
  'PostCropVignetteAmount',
  'PostCropVignetteMidpoint',
  'PostCropVignetteRoundness',
  'PostCropVignetteFeather',
  'PostCropVignetteHighlights',
  'GrainAmount',
  'GrainSize',
  'GrainFrequency',
];

function EffectsSection() {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const params = paramsForPhoto(state, photo);
  const style = params.PostCropVignetteStyle ?? 'Highlight Priority';
  return (
    <Section title="Effects" params={EFFECT_PARAMS}>
      <div className={styles.subgroup}>
        <h4 className={styles.subgroupTitle}>Post-crop vignette</h4>
        <Slider name="PostCropVignetteAmount" />
        <label className={styles.selectRow}>
          <span className={styles.selectLabel}>Style</span>
          <Select
            value={style}
            disabled={!photo}
            onChange={(event) => store.setVignetteStyle(event.target.value as VignetteStyle)}
          >
            {VIGNETTE_STYLES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <Slider name="PostCropVignetteMidpoint" />
        <Slider name="PostCropVignetteRoundness" />
        <Slider name="PostCropVignetteFeather" />
        <Slider name="PostCropVignetteHighlights" />
      </div>
      <div className={styles.subgroup}>
        <h4 className={styles.subgroupTitle}>Grain</h4>
        <Slider name="GrainAmount" />
        <Slider name="GrainSize" />
        <Slider name="GrainFrequency" />
      </div>
    </Section>
  );
}

/** Right panel: presets, then the Camera Raw compatible develop sliders. */
export function DevelopPanel({ className }: { className?: string }) {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);

  return (
    <Panel title="Develop" className={className}>
      <PanelSection
        title="Presets"
        flush
        actions={
          <Button
            variant="ghost"
            size="small"
            title="Import a Lightroom/Camera Raw .xmp preset"
            onClick={() => void store.importPreset()}
          >
            <PlusIcon size={10} /> Import
          </Button>
        }
      >
        <div className={styles.presets} data-testid="presets">
          {state.presets.length === 0 && <span className={styles.muted}>No presets imported</span>}
          {state.presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={styles.preset}
              title={preset.path}
              disabled={!photo}
              onClick={() => store.applyPreset(preset)}
            >
              <span className={styles.presetName}>{preset.name}</span>
              <span className={`${styles.presetCount} mono`}>
                {Object.keys(preset.params).length}
              </span>
            </button>
          ))}
        </div>
        {state.presetNotice && (
          <div className={styles.notice} role="status">
            {state.presetNotice}
            <button
              type="button"
              className={styles.noticeClose}
              aria-label="Dismiss preset notice"
              onClick={() => store.clearPresetNotice()}
            >
              <CloseIcon size={9} />
            </button>
          </div>
        )}
      </PanelSection>

      <div data-testid="sliders">
        {BASIC_GROUPS.map((group) => (
          <Group key={group.title} title={group.title} params={group.params} />
        ))}
        <DetailSection />
        <ColorMixerSection />
        <ColorGradingSection />
        <Group
          title="Calibration"
          params={[
            'ShadowTint',
            'RedHue',
            'RedSaturation',
            'GreenHue',
            'GreenSaturation',
            'BlueHue',
            'BlueSaturation',
          ]}
        />
        <Group
          title="Parametric curve"
          params={[
            'ParametricShadows',
            'ParametricDarks',
            'ParametricLights',
            'ParametricHighlights',
            'ParametricShadowSplit',
            'ParametricMidtoneSplit',
            'ParametricHighlightSplit',
          ]}
        />
        <EffectsSection />
      </div>
    </Panel>
  );
}
