// electron-builder's AppRun script starts the app with `--no-sandbox` by itself whenever
// `unshare -Ur true` fails, which is how Ubuntu 24.04's AppArmor policy answers an unprivileged
// user namespace. The sandbox must not be turned off without the user asking for it, so the AppImage
// is opened, that fallback is taken out of AppRun and the image is packed again with the same tools.
// A user who needs `--no-sandbox` passes it, see "Linux AppImage" in the README.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FALLBACK =
  /if \[ \$HAVE_NO_SANDBOX -eq 0 \] && ! unshare -Ur true 2>\/dev\/null ; then\n {2}NO_SANDBOX=\(--no-sandbox\)\nfi\n/;

interface AppImageTools {
  mksquashfs: string;
}

/** The AppRun with the automatic `--no-sandbox` removed. Throws when electron-builder's script changed. */
export function withoutSandboxFallback(appRun: string): string {
  if (!FALLBACK.test(appRun)) {
    throw new Error(
      'AppRun no longer has the --no-sandbox fallback this script removes. ' +
        'Check the AppRun of the new electron-builder and update scripts/appimage-sandbox.ts.',
    );
  }
  const patched = appRun.replace(FALLBACK, '');
  if (/NO_SANDBOX=\(--no-sandbox\)/.test(patched)) {
    throw new Error('AppRun still sets --no-sandbox somewhere else');
  }
  return patched;
}

/** mksquashfs as electron-builder uses it for the legacy (FUSE 2) AppImage runtime it builds with. */
async function mksquashfsPath(desktopPackageJson: string): Promise<string> {
  const fromDesktop = createRequire(desktopPackageJson);
  const fromBuilder = createRequire(fromDesktop.resolve('electron-builder'));
  const { getAppImageTools } = fromBuilder('app-builder-lib/out/toolsets/linux.js') as {
    getAppImageTools(version: string, arch: unknown): Promise<AppImageTools>;
  };
  const { Arch } = fromBuilder('builder-util') as { Arch: { x64: unknown } };
  return (await getAppImageTools('0.0.0', Arch.x64)).mksquashfs;
}

export async function removeSandboxFallback(
  appImage: string,
  desktopPackageJson: string,
): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'ee-appimage-'));
  try {
    const run = (args: string[]): string =>
      execFileSync(appImage, args, { cwd: work, encoding: 'utf8' });
    const offset = Number(run(['--appimage-offset']).trim());
    run(['--appimage-extract']);
    const appRunFile = join(work, 'squashfs-root', 'AppRun');
    writeFileSync(appRunFile, withoutSandboxFallback(readFileSync(appRunFile, 'utf8')), {
      mode: 0o755,
    });

    const runtime = readFileSync(appImage).subarray(0, offset);
    const output = join(work, 'repacked.AppImage');
    execFileSync(
      await mksquashfsPath(desktopPackageJson),
      [
        join(work, 'squashfs-root'),
        output,
        ...['-offset', String(offset), '-all-root', '-noappend', '-no-progress', '-quiet'],
        ...['-no-xattrs', '-no-fragments'],
      ],
      { stdio: 'inherit' },
    );
    const fd = openSync(output, 'r+');
    try {
      writeSync(fd, runtime, 0, runtime.length, 0);
    } finally {
      closeSync(fd);
    }
    execFileSync('chmod', ['755', output]);
    // Replace in place only once the new image exists.
    writeFileSync(appImage, readFileSync(output), { mode: 0o755 });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
