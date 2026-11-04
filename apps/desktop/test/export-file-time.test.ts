// @vitest-environment node
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureInstant, hasZone, setModifiedTime } from '../src/jobs/backend/export-file-time';

describe('captureInstant', () => {
  const originalZone = process.env.TZ;
  afterEach(() => {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  });

  it('pins the instant with a UTC offset', () => {
    expect(captureInstant('2025-03-08T19:45:12', '+01:00')?.toISOString()).toBe(
      '2025-03-08T18:45:12.000Z',
    );
    expect(captureInstant('2025-03-08T19:45:12', '-05:30')?.toISOString()).toBe(
      '2025-03-09T01:15:12.000Z',
    );
  });

  it('reads a zone-less time as this machine’s clock, in any zone', () => {
    process.env.TZ = 'Asia/Tokyo';
    expect(captureInstant('2025-03-08T19:45:12', undefined)?.toISOString()).toBe(
      '2025-03-08T10:45:12.000Z',
    );
    process.env.TZ = 'America/New_York';
    expect(captureInstant('2025-03-08T19:45:12', undefined)?.toISOString()).toBe(
      '2025-03-09T00:45:12.000Z',
    );
  });

  it('prefers the zone in the capture time over an offset tag', () => {
    expect(captureInstant('2025-03-08T19:45:12Z', '+01:00')?.toISOString()).toBe(
      '2025-03-08T19:45:12.000Z',
    );
    expect(captureInstant('2025-03-08T19:45:12.250+05:30', undefined)?.toISOString()).toBe(
      '2025-03-08T14:15:12.250Z',
    );
  });

  it('falls back to local time for an unusable offset', () => {
    process.env.TZ = 'UTC';
    expect(captureInstant('2025-03-08T19:45:12', 'garbage')?.toISOString()).toBe(
      '2025-03-08T19:45:12.000Z',
    );
    expect(captureInstant('2025-03-08T19:45:12', '+99:99')?.toISOString()).toBe(
      '2025-03-08T19:45:12.000Z',
    );
  });

  it('gives nothing when there is no moment to stamp', () => {
    expect(captureInstant(undefined, '+01:00')).toBeUndefined();
    expect(captureInstant('2025-03-08', '+01:00')).toBeUndefined();
    expect(captureInstant('0000-00-00T00:00:00', undefined)).toBeUndefined();
    expect(captureInstant('last Tuesday', undefined)).toBeUndefined();
  });

  it('knows whether a capture time names its zone', () => {
    expect(hasZone('2025-03-08T19:45:12')).toBe(false);
    expect(hasZone('2025-03-08T19:45:12+01:00')).toBe(true);
    expect(hasZone('2025-03-08T19:45:12Z')).toBe(true);
    expect(hasZone(undefined)).toBe(false);
  });
});

describe('setModifiedTime', () => {
  it('sets the modified time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-set-mtime-'));
    try {
      const file = join(dir, 'a.jpg');
      await writeFile(file, 'x');
      const warnings: string[] = [];
      const when = new Date('2025-03-08T18:45:12Z');

      expect(await setModifiedTime(file, when, (m) => warnings.push(m))).toBe(true);

      expect((await stat(file)).mtimeMs).toBe(when.getTime());
      expect(warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('warns instead of throwing when the file cannot be changed', async () => {
    const warnings: string[] = [];

    const ok = await setModifiedTime(join(tmpdir(), 'ee-no-such-dir', 'a.jpg'), new Date(), (m) =>
      warnings.push(m),
    );

    expect(ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not set the modified time');
  });
});
