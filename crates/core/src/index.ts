import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as Native from '../index.cjs';

/** Shape of the compiled addon, taken from the napi-generated declarations (`index.d.cts`). */
export type NativeBinding = typeof Native;

let cached: NativeBinding | undefined;

/**
 * Load the compiled addon (once).
 *
 * The addon path is derived from this package's location via module resolution
 * rather than from `import.meta.url`, so it keeps working when this file is
 * bundled into another output directory (electron-vite bundles it into the
 * utility process bundle).
 *
 * @throws if the addon has not been built for this platform (`pnpm build:native`).
 */
export function loadCore(): NativeBinding {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve('@ee/core/package.json'));
  try {
    cached = require(join(packageDir, 'index.cjs')) as NativeBinding;
  } catch (cause) {
    throw new Error(
      'Failed to load the native core addon. Build it with `pnpm build:native` (needs Rust).',
      { cause },
    );
  }
  return cached;
}

/** Version of the native core, so callers can tell which binary was loaded. */
export function coreVersion(): string {
  return loadCore().coreVersion();
}
