import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  delete (window as { eeTransport?: unknown }).eeTransport;
});
