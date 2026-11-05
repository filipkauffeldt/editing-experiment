import type { RetouchMode } from './retouch-areas';
import type { RetouchTool } from './store';

/**
 * The one line under the photo while Retouch or Crop is open: what a drag does and how the session
 * ends. Enter and Esc are in every hint because they are the way out.
 */
export function retouchHint(tool: RetouchTool, mode: RetouchMode): string {
  const ending = 'Enter or Esc saves';
  const toggle = 'click an area to switch it';
  if (tool === 'faces') {
    return mode === 'subtract'
      ? `Drag around faces to remove them · hold Alt for a lasso · ${ending}`
      : `Drag around faces · hold Alt for a lasso · ${toggle} · ${ending}`;
  }
  return tool === 'lasso'
    ? `Draw a freehand outline · ${toggle} · ${ending}`
    : `Drag a rectangle · ${toggle} · ${ending}`;
}

export const CROP_HINT =
  'Drag outside the frame to rotate · inside it to move the photo · Enter applies, Esc cancels';
