import { describe, expect, it } from 'vitest';
import { coreVersion, loadCore } from '../src/index';

describe('native core', () => {
  it('loads the addon and calls into Rust', () => {
    expect(coreVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the same binding on every call', () => {
    expect(loadCore()).toBe(loadCore());
  });
});
