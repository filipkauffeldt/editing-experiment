import { SLIDER_SPECS, type SliderParam, type VignetteStyle } from '@ee/contracts';
import { useState } from 'react';
import { activePhoto, paramsForPhoto } from '../store';
import { asShotTrackPosition, temperatureToTrack, trackToTemperature } from '../temperature-scale';
import { useAppState, useAppStore } from '../store-context';
import { CloseIcon, PlusIcon } from './icons';
import { Panel } from './Panel';
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
  { title: 'Presence', params: ['Vibrance', 'Saturation'] },
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
  const asShot = spec.neutral === null && raw === undefined;
  const isTemperature = name === 'Temperature';
  const position = isTemperature
    ? raw === undefined
      ? asShotTrackPosition()
      : temperatureToTrack(raw)
    : (raw ?? spec.neutral ?? 0);

  return (
    <div
      className={`${styles.slider} ${asShot ? styles.asShot : ''}`}
      onDoubleClick={() => store.resetSlider(name)}
      title="Double-click to reset"
    >
      <span className={styles.sliderLabel}>{LABELS[name]}</span>
      <input
        className={styles.number}
        type="number"
        aria-label={`${LABELS[name]} value`}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={asShot ? '' : (raw ?? spec.neutral ?? 0)}
        placeholder={asShot ? 'As shot' : undefined}
        disabled={!photo}
        onChange={(event) => {
          const value = event.target.value;
          if (value === '') {
            store.setSlider(name, undefined);
            return;
          }
          const parsed = Number(value);
          if (Number.isFinite(parsed)) store.setSlider(name, parsed);
        }}
      />
      <input
        className={styles.range}
        type="range"
        aria-label={LABELS[name]}
        min={isTemperature ? 0 : spec.min}
        max={isTemperature ? 1000 : spec.max}
        step={isTemperature ? 1 : spec.step}
        value={position}
        disabled={!photo}
        onChange={(event) =>
          store.setSlider(
            name,
            isTemperature
              ? trackToTemperature(Number(event.target.value))
              : Number(event.target.value),
          )
        }
        onDoubleClick={() => store.resetSlider(name)}
      />
    </div>
  );
}

function Group({ title, params }: { title: string; params: SliderParam[] }) {
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      {params.map((name) => (
        <Slider key={name} name={name} />
      ))}
    </section>
  );
}

function ColorMixerSection() {
  const [tab, setTab] = useState<MixerTab>('Hue');
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>Color Mixer</h3>
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
    </section>
  );
}

function ColorGradingSection() {
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>Color Grading</h3>
      {(
        [
          ['Shadows', 'ColorGradeShadow'],
          ['Midtones', 'ColorGradeMidtone'],
          ['Highlights', 'ColorGradeHighlight'],
          ['Global', 'ColorGradeGlobal'],
        ] as const
      ).map(([label, prefix]) => (
        <div key={label} className={styles.subgroup}>
          <h4 className={styles.subgroupTitle}>{label}</h4>
          <Slider name={`${prefix}Hue` as SliderParam} />
          <Slider name={`${prefix}Sat` as SliderParam} />
          <Slider name={`${prefix}Lum` as SliderParam} />
        </div>
      ))}
      <Slider name="ColorGradeBlending" />
      <Slider name="ColorGradeBalance" />
    </section>
  );
}

const VIGNETTE_STYLES: VignetteStyle[] = ['Highlight Priority', 'Color Priority', 'Paint Overlay'];

function EffectsSection() {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const params = paramsForPhoto(state, photo);
  const style = params.PostCropVignetteStyle ?? 'Highlight Priority';
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>Effects</h3>
      <div className={styles.subgroup}>
        <h4 className={styles.subgroupTitle}>Post-crop vignette</h4>
        <Slider name="PostCropVignetteAmount" />
        <label className={styles.selectRow}>
          <span className={styles.sliderLabel}>Style</span>
          <select
            className={styles.select}
            value={style}
            disabled={!photo}
            onChange={(event) => store.setVignetteStyle(event.target.value as VignetteStyle)}
          >
            {VIGNETTE_STYLES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
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
    </section>
  );
}

/** Right panel: presets, then the Camera Raw compatible develop sliders. */
export function DevelopPanel({ className }: { className?: string }) {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);

  return (
    <Panel title="Develop" className={className}>
      <div className={styles.sectionTitle}>
        Presets
        <button
          type="button"
          className={styles.iconButton}
          title="Import a Lightroom/Camera Raw .xmp preset"
          onClick={() => void store.importPreset()}
        >
          <PlusIcon size={11} /> Import
        </button>
      </div>

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
            <span className={styles.presetCount}>{Object.keys(preset.params).length} settings</span>
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

      <div data-testid="sliders">
        {BASIC_GROUPS.map((group) => (
          <Group key={group.title} title={group.title} params={group.params} />
        ))}
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
