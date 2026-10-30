import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no canvas implementation and logs a "Not implemented" error for
// every 2D draw. The components already handle a missing context; return null
// quietly so tests that are not about pixels stay readable.
if (typeof HTMLCanvasElement !== 'undefined') {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    ...args: Parameters<typeof original>
  ): ReturnType<typeof original> {
    if (args[0] === '2d') return null;
    return original.apply(this, args);
  } as typeof original;
}

afterEach(() => {
  cleanup();
  // Backend tests run in the node environment, which has no window.
  if (typeof window !== 'undefined') delete (window as { eeTransport?: unknown }).eeTransport;
});
