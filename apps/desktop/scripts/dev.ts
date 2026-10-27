// `pnpm dev`: electron-vite dev server plus Electron. With EE_NO_SANDBOX=1, Electron is
// started with --no-sandbox. Chromium reads that flag before any app code runs, so it
// has to be a launch argument; it cannot be set from the main process.
import { spawn } from 'node:child_process';

const noSandbox = process.env.EE_NO_SANDBOX === '1';
const args = ['dev', ...(noSandbox ? ['--', '--no-sandbox'] : [])];

const child = spawn('electron-vite', args, {
  stdio: 'inherit',
  // electron-vite is a .cmd shim on Windows.
  shell: process.platform === 'win32',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
