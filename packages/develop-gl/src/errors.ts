/** Thrown when WebGL2 is unavailable or a GL resource cannot be created. */
export class DevelopGlError extends Error {
  override readonly name = 'DevelopGlError';
}
