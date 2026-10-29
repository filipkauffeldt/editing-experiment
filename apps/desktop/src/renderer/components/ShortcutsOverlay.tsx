import { useAppStore } from '../store-context';
import { Modal } from './Modal';
import styles from './ShortcutsOverlay.module.css';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Navigate',
    rows: [
      ['← / →', 'Previous / next photo'],
      ['Ctrl/⌘ + Enter', 'Finish & next'],
      ['?', 'Show this shortcut list'],
      ['Esc', 'Leave the current field'],
    ],
  },
  {
    title: 'Crop and straighten',
    rows: [
      ['C', 'Enter crop mode / apply the crop'],
      ['Drag outside the frame', 'Rotate the photo (Shift snaps to 1°)'],
      ['Drag inside the frame', 'Move the photo under the frame'],
      ['Drag a handle', 'Resize (Shift toggles the aspect lock, Alt/⌥ from the centre)'],
      ['R', 'Crop frame tool: drag out a new frame'],
      ['A', 'Straighten tool: draw a line along the horizon'],
      ['O', 'Cycle the overlay (thirds, grid, golden ratio, none)'],
      ['X', 'Swap portrait / landscape'],
      ['Enter / double-click', 'Apply the crop'],
      ['Esc', 'Cancel the crop'],
      ['Ctrl/⌘ + Alt/⌥ + R', 'Reset the crop'],
    ],
  },
  {
    title: 'Cull and classify',
    rows: [
      ['T', 'Tag / untag photo'],
      ['0 – 8', 'Set colour class (0 clears)'],
    ],
  },
  {
    title: 'Caption',
    rows: [
      ['Ctrl/⌘ + I', 'Focus the caption field'],
      ['Ctrl + Space', 'Expand codes and {variables}'],
    ],
  },
];

/** Keyboard cheat sheet, opened with `?`. */
export function ShortcutsOverlay() {
  const store = useAppStore();
  return (
    <Modal
      title="Keyboard shortcuts"
      subtitle="Shortcuts stay out of the way while you type; the command keys above still work."
      onClose={() => store.toggleShortcuts(false)}
      width={460}
      testId="shortcuts-overlay"
    >
      <div className={styles.groups}>
        {GROUPS.map((group) => (
          <section key={group.title} className={styles.group}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            {group.rows.map(([keys, label]) => (
              <div key={keys} className={styles.row}>
                <span className={styles.label}>{label}</span>
                <kbd className={styles.keys}>{keys}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
