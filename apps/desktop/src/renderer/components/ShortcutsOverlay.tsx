import { useAppStore } from '../store-context';
import { Modal } from './Modal';
import styles from './ShortcutsOverlay.module.css';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Navigate',
    rows: [
      ['← / →', 'Previous / next photo'],
      ['? / F1', 'Show this shortcut list'],
      ['Esc', 'Leave the current field'],
    ],
  },
  {
    title: 'Export',
    rows: [
      ['Shift + Ctrl/⌘ + E', 'Export…'],
      ['Shift + Ctrl/⌘ + Enter', 'Export & send'],
      ['Ctrl/⌘ + Enter', 'Next & send'],
    ],
  },
  {
    title: 'Develop settings',
    rows: [
      ['Shift + Ctrl/⌘ + C', 'Copy settings…'],
      ['Shift + Ctrl/⌘ + V', 'Paste settings to the selection'],
      ['Ctrl/⌘ + Alt/⌥ + V', "Paste the previous photo's settings"],
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
    title: 'Retouch',
    rows: [
      ['R', 'Enter retouch mode / save and leave it'],
      ['Esc', 'Drop the shape being drawn; otherwise save and leave'],
      ['Click an area', 'Switch it on or off'],
      ['Alt/⌥ + drag', 'Flip Add and Subtract for that drawing'],
      ['Subtract + Detect faces', 'Delete the faces inside the dragged area'],
      ['Ctrl/⌘ + Z', 'Undo the last change to the areas'],
    ],
  },
  {
    title: 'Develop',
    rows: [
      ['Y', 'Before / after'],
      ['J', 'Show clipping (red highlights, blue shadows)'],
      ['W', 'White balance picker (Esc cancels)'],
      ['Split', 'Before/after split view (button in Develop)'],
    ],
  },
  {
    title: 'Zoom and pan',
    rows: [
      ['Z', 'Toggle Fit and the chosen zoom level (100% to start)'],
      ['Ctrl/⌘ + + / −', 'Zoom in / out in steps'],
      ['Ctrl/⌘ + wheel or pinch', 'Zoom around the pointer'],
      ['Scroll', 'Pan the zoomed photo, in every mode (Shift scrolls sideways)'],
      ['Space + drag', 'Pan, in every mode (the tool is paused)'],
    ],
  },
  {
    title: 'Cull and classify',
    rows: [
      ['T', 'Tag / untag photo'],
      ['1 – 5', 'Set the star rating (0 clears)'],
      ['Ctrl/⌘ + 1 – 8', 'Set the colour class (Ctrl/⌘ + 0 clears)'],
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
