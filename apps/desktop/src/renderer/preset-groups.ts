import type { EditPreset } from '@ee/contracts';

export interface PresetGroup {
  /** `Sport/Fotboll`; empty for the presets that have no group. */
  name: string;
  presets: EditPreset[];
}

/**
 * The presets in groups, for the pickers: the ungrouped ones first, then the groups by name, each
 * keeping the order it came in (the backend sorts by name). Presets with the same name stay apart.
 */
export function groupPresets(presets: readonly EditPreset[]): PresetGroup[] {
  const groups = new Map<string, EditPreset[]>();
  for (const preset of presets) {
    const name = preset.group ?? '';
    const members = groups.get(name);
    if (members) members.push(preset);
    else groups.set(name, [preset]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, members]) => ({ name, presets: members }));
}
