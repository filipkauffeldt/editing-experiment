import platformPath, { type PlatformPath } from 'node:path';

/**
 * A path in the shared settings file. A file at or below the settings folder is stored
 * relative to it, so it resolves on every machine. Any other path belongs to the computer
 * that added it and is stored in `machine.json` under an id.
 */
export type SettingsPathRef = { folder: string } | { machine: string };

export function isSettingsPathRef(value: unknown): value is SettingsPathRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const folder = ref.folder;
  const machine = ref.machine;
  return (
    (typeof folder === 'string' && machine === undefined) ||
    (typeof machine === 'string' && machine !== '' && folder === undefined)
  );
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** `C:\x` and `\\server\share`, which POSIX must never resolve. */
export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE.test(value) || value.startsWith('\\\\');
}

/** `/x`, which Windows path rules would treat as a root on the current drive. */
export function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith('/');
}

/** An absolute path of either system, so a Windows path is recognised on Linux. */
export function isAbsolutePathFromEitherSystem(value: string): boolean {
  return isWindowsAbsolutePath(value) || isPosixAbsolutePath(value);
}

function systemOf(value: string): 'posix' | 'win32' | undefined {
  if (isWindowsAbsolutePath(value)) return 'win32';
  if (isPosixAbsolutePath(value)) return 'posix';
  return undefined;
}

function systemOfApi(path: PlatformPath): 'posix' | 'win32' {
  return path.sep === '\\' ? 'win32' : 'posix';
}

/**
 * The path below `folder` with forward slashes, or undefined when `file` is not below it.
 * Only the same path system is compared: a `C:\…` path is never resolved on Linux and a
 * POSIX path is never resolved on Windows.
 */
export function relativeToSettingsFolder(
  folder: string,
  file: string,
  path: PlatformPath = platformPath,
): string | undefined {
  const system = systemOf(folder);
  if (system === undefined || system !== systemOf(file) || system !== systemOfApi(path)) {
    return undefined;
  }
  const relative = path.relative(path.normalize(folder), path.normalize(file));
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
}

/** Resolve a stored relative path below the settings folder, using this platform's rules. */
export function resolveUnderSettingsFolder(
  folder: string,
  relative: string,
  path: PlatformPath = platformPath,
): string | undefined {
  if (relative === '' || isAbsolutePathFromEitherSystem(relative)) return undefined;
  if (path.isAbsolute(relative)) return undefined;
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  // A backslash is a separator under Windows rules, so let the join decide and then
  // confirm the result is still below the folder.
  const joined = path.join(folder, ...segments);
  return relativeToSettingsFolder(folder, joined, path) === undefined ? undefined : joined;
}

/**
 * The absolute path a shared reference points at. A machine path is returned as it was
 * stored, never joined to the settings folder, also when it belongs to the other system.
 * `undefined` for a machine path this computer does not have.
 */
export function resolveSettingsPath(
  folder: string,
  ref: SettingsPathRef,
  machinePaths: Readonly<Record<string, string>>,
  path: PlatformPath = platformPath,
): string | undefined {
  if ('folder' in ref) return resolveUnderSettingsFolder(folder, ref.folder, path);
  return machinePaths[ref.machine];
}
