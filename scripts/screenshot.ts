// Launches the built desktop app (apps/desktop/out) with mock data and saves PNGs.
// Usage: pnpm screenshot [--out <dir>]   (builds first; see package.json)
import { _electron as electron } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseOutDir(argv: string[]): string {
  const index = argv.indexOf('--out');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && !value) throw new Error('--out needs a directory');
  return resolve(value ?? join(root, 'screenshots'));
}

// Electron needs a display even when nothing is shown. On a headless Linux box,
// re-run ourselves under Xvfb instead of failing with an opaque Electron abort.
function ensureDisplay(): void {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return;
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    console.error(
      'No display found and xvfb-run is not installed.\n' +
        'Install it with: sudo apt install xvfb xauth   (or run with DISPLAY set)',
    );
    process.exit(1);
  }
  const rerun = spawnSync(
    'xvfb-run',
    ['-a', '--server-args=-screen 0 1600x1000x24', process.execPath, ...process.argv.slice(1)],
    { stdio: 'inherit' },
  );
  process.exit(rerun.status ?? 1);
}

async function main(): Promise<void> {
  ensureDisplay();
  const outDir = parseOutDir(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  // Resolve electron from the desktop app (not the repo root); on first use this
  // downloads the binary, since Electron has no install script.
  const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));
  const app = await electron.launch({
    executablePath: desktopRequire('electron') as string,
    args: [join(root, 'apps/desktop')],
    env: {
      ...process.env,
      EE_MOCK: '1',
    },
  });
  try {
    const window = await app.firstWindow();
    const problems: string[] = [];
    window.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    window.on('pageerror', (error) => problems.push(error.message));

    await window.waitForFunction(
      () => {
        const images = [...document.querySelectorAll('[data-testid="film-strip"] img')];
        return images.length > 0 && images.every((img) => (img as HTMLImageElement).complete);
      },
      undefined,
      { timeout: 20_000 },
    );
    await window.getByText('MOCK').waitFor();
    await window.getByText(/round trip/).waitFor();

    const layout = join(outDir, 'layout.png');
    await window.screenshot({ path: layout });
    console.log(`wrote ${layout}`);

    if (problems.length > 0) throw new Error(`renderer reported errors:\n${problems.join('\n')}`);
  } finally {
    await app.close();
  }
}

await main();
