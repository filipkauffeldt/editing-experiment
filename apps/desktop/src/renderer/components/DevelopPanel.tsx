import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { activePhoto, paramsForPhoto } from '../store';
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
};

const GROUPS: { title: string; params: SliderParam[] }[] = [
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

function Slider({ name }: { name: SliderParam }) {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const params = paramsForPhoto(state, photo);
  const spec = SLIDER_SPECS[name];
  const raw = params[name];
  const asShot = spec.neutral === null && raw === undefined;
  const position = raw ?? (name === 'Temperature' ? 5500 : 0);

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
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={position}
        disabled={!photo}
        onChange={(event) => store.setSlider(name, Number(event.target.value))}
        onDoubleClick={() => store.resetSlider(name)}
      />
    </div>
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
        {GROUPS.map((group) => (
          <section key={group.title} className={styles.group}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            {group.params.map((name) => (
              <Slider key={name} name={name} />
            ))}
          </section>
        ))}
      </div>
    </Panel>
  );
}
