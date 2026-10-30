import {
  DEFAULT_COPY_SETTING_GROUPS,
  DEVELOP_SETTING_GROUPS,
  type DevelopSettingGroupId,
} from '@ee/contracts';
import { useState } from 'react';
import { activePhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import styles from './CopySettingsDialog.module.css';

/**
 * Lightroom's Copy/Sync Settings dialog: one checkbox per group, with Crop off
 * by default. Retouch is not a develop setting, so it is never in this list.
 */
export function CopySettingsDialog() {
  const store = useAppStore();
  const state = useAppState();
  const mode = state.copySettings?.mode ?? 'copy';
  const photo = activePhoto(state);
  const [groups, setGroups] = useState<DevelopSettingGroupId[]>(() => [
    ...DEFAULT_COPY_SETTING_GROUPS,
  ]);
  const selected = new Set(groups);

  const toggle = (id: DevelopSettingGroupId): void =>
    setGroups((current) =>
      current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id],
    );
  const setAll = (checked: boolean): void =>
    setGroups(checked ? DEVELOP_SETTING_GROUPS.map((group) => group.id) : []);

  return (
    <Modal
      title={mode === 'copy' ? 'Copy Settings' : 'Sync Settings'}
      subtitle={
        mode === 'copy'
          ? `Copy from ${photo?.fileName ?? 'the active photo'}, then paste with Shift+Ctrl/⌘+V.`
          : `Apply ${photo?.fileName ?? 'the active photo'}'s settings to the ${Math.max(1, state.selection.length)} selected photos.`
      }
      onClose={() => store.closeCopySettings()}
      width={620}
      testId="copy-settings-dialog"
      footer={
        <>
          <Button size="small" variant="ghost" onClick={() => setAll(true)}>
            Select all
          </Button>
          <Button size="small" variant="ghost" onClick={() => setAll(false)}>
            Select none
          </Button>
          <span className={styles.spacer} />
          <Button onClick={() => store.closeCopySettings()}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="copy-settings-confirm"
            disabled={groups.length === 0}
            onClick={() => store.confirmCopySettings(groups)}
          >
            {mode === 'copy' ? 'Copy' : 'Sync'}
          </Button>
        </>
      }
    >
      <div className={styles.groups} role="group" aria-label="Settings to copy">
        {DEVELOP_SETTING_GROUPS.map((group) => (
          <label key={group.id} className={styles.group}>
            <input
              type="checkbox"
              data-testid={`copy-group-${group.id}`}
              checked={selected.has(group.id)}
              onChange={() => toggle(group.id)}
            />
            <span className={styles.text}>
              <span className={styles.label}>{group.label}</span>
              <span className={styles.count}>
                {group.fields.length} setting{group.fields.length === 1 ? '' : 's'}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className={styles.note}>
        Retouch is never copied: mosaics stay with each photo. Crop is off by default.
      </p>
    </Modal>
  );
}
