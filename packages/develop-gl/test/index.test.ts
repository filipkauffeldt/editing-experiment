import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index';

describe('@ee/develop-gl', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE_NAME).toBe('@ee/develop-gl');
  });
});
