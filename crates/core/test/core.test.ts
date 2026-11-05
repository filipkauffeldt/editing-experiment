import { describe, expect, it } from 'vitest';
import { coreVersion, loadCore, readDriveInfo } from '../src/index';

describe('native core', () => {
  it('loads the addon and calls into Rust', () => {
    expect(coreVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the same binding on every call', () => {
    expect(loadCore()).toBe(loadCore());
  });
});

describe('readDriveInfo', () => {
  it.runIf(process.platform !== 'win32')('has nothing to report off Windows', async () => {
    await expect(readDriveInfo(['E:\\'])).resolves.toEqual([]);
  });

  it.runIf(process.platform === 'win32')('reads the system drive as a fixed disk', async () => {
    const [drive] = await readDriveInfo(['C:\\']);
    expect(drive).toMatchObject({ root: 'C:\\', driveType: 3 });
    expect(drive?.errorCode).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('refuses a root that is not a drive letter', async () => {
    const [drive] = await readDriveInfo(['\\\\localhost\\C$\\']);
    expect(drive).toMatchObject({ driveType: 0, errorCode: 87 });
  });
});
