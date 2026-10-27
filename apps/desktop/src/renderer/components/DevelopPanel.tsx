import { SLIDER_PARAMS, SLIDER_SPECS } from '@ee/contracts';
import { Panel } from './Panel';
import styles from './DevelopPanel.module.css';

interface DevelopPanelProps {
  className?: string;
}

/** Right panel: preset list on top, develop sliders below. Placeholder, sliders are not wired yet. */
export function DevelopPanel({ className }: DevelopPanelProps) {
  return (
    <Panel title="Presets" className={className}>
      <div className={styles.presets}>No presets imported</div>
      <div data-testid="sliders">
        {SLIDER_PARAMS.map((name) => {
          const spec = SLIDER_SPECS[name];
          const neutral = spec.neutral ?? (spec.min + spec.max) / 2;
          return (
            <label key={name} className={styles.slider}>
              <span>{name.replace(/2012$/, '')}</span>
              <span className={styles.value}>{spec.neutral === null ? 'As shot' : neutral}</span>
              <input
                type="range"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                defaultValue={neutral}
                disabled
              />
            </label>
          );
        })}
      </div>
    </Panel>
  );
}
