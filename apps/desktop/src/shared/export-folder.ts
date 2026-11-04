// No Node imports: the renderer uses this too.

/**
 * Exports go into a folder next to the photo they came from: `{photofolder}` is the folder
 * of the photo's ingested file, so `/Photos/20261104_GAIS-AIK/_DSC1234.NEF` exports to
 * `/Photos/20261104_GAIS-AIK/export/`.
 */
export const DEFAULT_FOLDER_TEMPLATE = '{photofolder}/export';

/** Folder name the default template creates; reconcile treats a folder of this name as exports. */
export const EXPORT_FOLDER_NAME = 'export';

/**
 * The default before exports moved next to the photo. A saved preset that still has exactly
 * this template never chose it, so it follows the new default; an edited one is left alone.
 */
export const LEGACY_DEFAULT_FOLDER_TEMPLATE = '{folder}/Export/{preset}';

const PHOTO_FOLDER_START = /^\s*\{\s*photofolder\s*\}[\\/]*/i;

/** Short text for a folder template in the Develop header, which has little room. */
export function describeFolderTemplate(template: string, presetName: string): string {
  const expanded = template.replace('{preset}', presetName);
  if (PHOTO_FOLDER_START.test(expanded)) {
    const rest = expanded.replace(PHOTO_FOLDER_START, '');
    return rest === '' ? 'next to the photo' : `${rest} (next to the photo)`;
  }
  return expanded.replace(/^\{folder\}\//, '');
}
