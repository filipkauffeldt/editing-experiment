import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // Backend tests run in the node environment, which has no window.
  if (typeof window !== 'undefined') delete (window as { eeTransport?: unknown }).eeTransport;
});
