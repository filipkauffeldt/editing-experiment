/** Label of the command key for hints: ⌘ on macOS, Ctrl elsewhere. */
export function modKeyLabel(): string {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';
}
