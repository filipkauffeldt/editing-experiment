import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Electron's executable links the system glib/gobject/gio at startup, and sharp's
 * libvips ships its own copy of them. With the default symbol lookup libvips'
 * `g_*` calls can bind to the system copy instead of its own, and the two type
 * systems disagree ("g_object_unref: assertion 'G_IS_OBJECT' failed", and on some
 * glib versions a segfault in the first image operation). Plain Node has no system
 * glib, which is why this only shows up inside Electron.
 *
 * Loading sharp's addon once with `RTLD_DEEPBIND` makes it (and libvips) prefer
 * their own symbols. The later `require('sharp')` finds the library already loaded.
 * This module must be imported before anything that imports sharp.
 */
export function loadSharpAddonIsolated(): void {
  if (process.platform !== 'linux' || process.env.EE_SHARP_DEEPBIND !== '1') return;
  try {
    const require = createRequire(import.meta.url);
    const sharpRequire = createRequire(
      join(dirname(require.resolve('sharp/package.json')), 'package.json'),
    );
    const musl = (
      process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    )?.header?.glibcVersionRuntime
      ? ''
      : 'musl';
    // `./sharp.node` resolves to a small index.cjs; the addon itself sits next to it in lib/.
    const entry = sharpRequire.resolve(`@img/sharp-linux${musl}-${process.arch}/sharp.node`);
    const libDir = join(dirname(entry), 'lib');
    const file = readdirSync(libDir).find((name) => name.endsWith('.node'));
    if (!file) throw new Error(`no .node file in ${libDir}`);
    const addon = join(libDir, file);
    process.dlopen(
      { exports: {} } as NodeJS.Module,
      addon,
      constants.dlopen.RTLD_NOW | constants.dlopen.RTLD_DEEPBIND,
    );
  } catch (error) {
    // sharp then loads the normal way; surface why isolation did not happen.
    console.warn('could not load sharp in an isolated symbol scope:', error);
  }
}

loadSharpAddonIsolated();
