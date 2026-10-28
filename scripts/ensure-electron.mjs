// Resolving the `electron` package downloads its binary on first use. Do it
// once, before any test launches Electron, so two test files cannot race while
// one is still writing the executable (ETXTBSY on CI).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(join(root, 'apps', 'desktop', 'package.json'));
const executable = desktopRequire('electron');

if (typeof executable !== 'string' || !existsSync(executable)) {
  console.error('Electron binary is not available after resolution');
  process.exit(1);
}
console.log(`Electron binary ready: ${executable}`);
