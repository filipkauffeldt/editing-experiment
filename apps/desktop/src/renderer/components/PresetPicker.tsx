import { useEffect, useMemo, useState } from 'react';
import { activePhoto } from '../store';
import { groupPresets } from '../preset-groups';
import { useAppState, useAppStore } from '../store-context';
import { CloseIcon, PlusIcon, RefreshIcon } from './icons';
import { Menu } from './ui/Menu';
import styles from './PresetPicker.module.css';

/** Up to this many presets every group starts open; with more, the groups start closed. */
const OPEN_ALL_UP_TO = 40;

/**
 * The develop presets, one row in the Develop panel: a label and a menu, so hundreds of presets
 * never push the sliders down. The menu lists the ones found in the preset folders and the
 * imported ones, in groups (`Sport/Fotboll`, or the group the preset file names) that open and
 * close, with Refresh and Import at its top. It reads the folders again when it is shown and when
 * Refresh is pressed, never on a timer.
 */
export function PresetPicker() {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const groups = useMemo(() => groupPresets(state.presets), [state.presets]);
  // Groups the user opened or closed; the rest follow the default for this many presets.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const openByDefault = state.presets.length <= OPEN_ALL_UP_TO;

  useEffect(() => {
    void store.loadPresetIndex(true);
  }, [store]);

  const isOpen = (name: string): boolean => openByDefault !== toggled.has(name);
  const toggle = (name: string): void =>
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const button = (preset: (typeof state.presets)[number], indented: boolean) => (
    <button
      key={preset.id}
      type="button"
      role="menuitem"
      className={`${styles.preset} ${indented ? styles.indented : ''}`}
      title={preset.path}
      disabled={!photo}
      onClick={() => store.applyPreset(preset)}
    >
      <span className={styles.presetName}>{preset.name}</span>
      <span className={`${styles.presetCount} mono`}>{Object.keys(preset.params).length}</span>
    </button>
  );

  return (
    <>
      <div className={styles.row} data-testid="preset-row">
        <span className={styles.label}>Preset</span>
        <Menu
          fill
          closeOnPick
          label="Apply preset"
          badge={state.presets.length > 0 ? state.presets.length : undefined}
          testId="preset-menu"
        >
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.tool}
              title="Read the preset folders again"
              aria-label="Refresh presets"
              onClick={() => void store.loadPresetIndex(true)}
            >
              <RefreshIcon size={10} />
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.tool}
              title="Import a Lightroom/Camera Raw .xmp preset"
              onClick={() => void store.importPreset()}
            >
              <PlusIcon size={10} /> Import
            </button>
          </div>
          <div className={styles.presets} data-testid="presets">
            {state.presets.length === 0 && (
              <span className={styles.muted}>
                No presets found. Add a preset folder in Settings → Presets, or import one.
              </span>
            )}
            {groups.map((group) =>
              group.name === '' ? (
                group.presets.map((preset) => button(preset, false))
              ) : (
                <div
                  key={group.name}
                  role="group"
                  aria-label={group.name}
                  data-testid="preset-group"
                >
                  <button
                    type="button"
                    className={`${styles.group} ${isOpen(group.name) ? styles.groupOpen : ''}`}
                    aria-expanded={isOpen(group.name)}
                    onClick={() => toggle(group.name)}
                  >
                    <span className={styles.caret} aria-hidden />
                    <span className={styles.groupName}>{group.name}</span>
                    <span className={`${styles.groupCount} mono`}>{group.presets.length}</span>
                  </button>
                  {isOpen(group.name) && group.presets.map((preset) => button(preset, true))}
                </div>
              ),
            )}
          </div>
        </Menu>
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
    </>
  );
}
