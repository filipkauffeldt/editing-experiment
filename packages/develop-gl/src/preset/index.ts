import { parsePresetLrtemplate } from './lrtemplate';
import { PresetParseError, type ParsedPreset, type ParseOptions } from './settings';
import { parsePresetXmp } from './xmp';

export { applyPreset, PresetParseError } from './settings';
export type { ParsedPreset, ParseOptions } from './settings';
export { parsePresetLrtemplate } from './lrtemplate';
export { parsePresetXmp } from './xmp';

/** Parses preset file contents; the format comes from the file extension, else from the content. */
export function parsePreset(text: string, options: ParseOptions = {}): ParsedPreset {
  const path = options.path?.toLowerCase() ?? '';
  if (path.endsWith('.lrtemplate')) return parsePresetLrtemplate(text, options);
  if (path.endsWith('.xmp')) return parsePresetXmp(text, options);
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) return parsePresetXmp(text, options);
  if (/^\w+\s*=\s*\{/.test(trimmed) || trimmed.startsWith('{'))
    return parsePresetLrtemplate(text, options);
  throw new PresetParseError('Unrecognised preset format (expected .xmp or .lrtemplate)');
}
