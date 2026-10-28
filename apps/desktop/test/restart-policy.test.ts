// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RestartPolicy } from '../src/main/restart-policy';

describe('RestartPolicy', () => {
  it('backs off exponentially and gives up after too many crashes in the window', () => {
    const policy = new RestartPolicy({
      maxCrashes: 4,
      windowMs: 10_000,
      baseDelayMs: 100,
      maxDelayMs: 350,
    });
    expect(policy.onCrash(0)).toBe(100);
    expect(policy.onCrash(1_000)).toBe(200);
    expect(policy.onCrash(2_000)).toBe(350);
    expect(policy.onCrash(3_000)).toBeUndefined();
  });

  it('forgets crashes that are older than the window', () => {
    const policy = new RestartPolicy({ maxCrashes: 3, windowMs: 1_000, baseDelayMs: 100 });
    expect(policy.onCrash(0)).toBe(100);
    expect(policy.onCrash(500)).toBe(200);
    // The first two are outside the window by now, so this counts as the first crash again.
    expect(policy.onCrash(5_000)).toBe(100);
    expect(policy.onCrash(5_100)).toBe(200);
  });
});
