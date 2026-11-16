// Builds the installable app: `node scripts/package-app.ts linux` makes an x64 AppImage and
// `node scripts/package-app.ts win` an x64 NSIS installer, both in apps/desktop/release/.
// Each runs on its own platform only: electron-builder cannot make either one from the other.
//
// `--skip-native` uses the addon that is already built, for CI jobs that were handed it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const release = join(desktop, 'release');

const target = process.argv[2];
const skipNative = process.argv.includes('--skip-native');
const targets = {
  linux: { host: 'linux', flag: '--linux', artifact: /\.AppImage$/ },
  win: { host: 'win32', flag: '--win', artifact: /-setup\.exe$/ },
} as const;

if (target !== 'linux' && target !== 'win') {
  console.error('Usage: node scripts/package-app.ts <linux|win> [--skip-native]');
  process.exit(2);
}
const spec = targets[target];
if (process.platform !== spec.host) {
  console.error(`The ${target} package is built on ${spec.host}, this is ${process.platform}.`);
  process.exit(2);
}

function run(command: string, args: string[]): void {
  console.log(`\n> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    // pnpm is a .cmd shim on Windows, which spawn only starts through a shell.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`Failed: ${command} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

if (!skipNative) run('pnpm', ['build:native']);
// The addon is the one thing electron-builder only warns about when it is missing.
const addons = readdirSync(join(root, 'crates', 'core')).filter((name) => name.endsWith('.node'));
if (addons.length === 0) {
  console.error('crates/core has no built addon. Run `pnpm build:native` first.');
  process.exit(1);
}
run('node', ['scripts/fetch-retouch.ts']);
if (!existsSync(join(root, 'fixtures', 'models', 'face_detection_yunet_2026may.onnx'))) {
  console.error('The YuNet model is missing after `fetch-retouch`.');
  process.exit(1);
}
run('pnpm', ['--filter', '@ee/desktop', 'run', 'build']);
run('pnpm', [
  '--filter',
  '@ee/desktop',
  'exec',
  'electron-builder',
  spec.flag,
  '--x64',
  '--publish',
  'never',
]);

const version = (
  JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as { version: string }
).version;
const built = readdirSync(release).filter(
  (name) => spec.artifact.test(name) && name.includes(version),
);
if (built.length === 0) {
  console.error(`electron-builder produced no ${target} package in ${release}`);
  process.exit(1);
}
for (const name of built) console.log(`\nBuilt ${join(release, name)}`);
