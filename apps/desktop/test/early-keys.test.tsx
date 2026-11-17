import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { EARLY_KEY_MAX_AGE_MS, collectEarlyKeys, type KeyTarget } from '../src/shared/early-keys';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge } from './fake-bridge';

/** A DOM event target standing in for the page's `window`. */
const collect = (target: EventTarget, now?: () => number) =>
  collectEarlyKeys(target as unknown as KeyTarget, now);

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
};

describe('keys pressed while the page loads', () => {
  it('collects them in order from the first moment, and hands them over once', () => {
    const target = new EventTarget();
    const early = collect(target);
    press(target, 'g');
    press(target, 'd', { shiftKey: true });
    expect(early.take().map((key) => [key.key, key.shiftKey])).toEqual([
      ['g', false],
      ['d', true],
    ]);
    // Taking ends the collecting: the shell's own handler hears every key after that.
    press(target, 'e');
    expect(early.take()).toEqual([]);
  });

  it('keeps no modifier or dead key on its own, and nothing that could be AltGr', () => {
    const target = new EventTarget();
    const early = collect(target);
    press(target, 'Shift', { shiftKey: true });
    press(target, 'Control', { ctrlKey: true });
    press(target, 'AltGraph');
    press(target, 'Dead');
    press(target, '@', { ctrlKey: true, altKey: true });
    press(target, '7', { ctrlKey: true, altKey: true });
    press(target, 'å');
    expect(early.take().map((key) => key.key)).toEqual(['å']);
  });

  it('keeps a bounded number, and drops a key the user moved on from', () => {
    let clock = 1_000;
    const target = new EventTarget();
    const early = collect(target, () => clock);
    press(target, 'a');
    clock += EARLY_KEY_MAX_AGE_MS + 1;
    press(target, 'b');
    expect(early.take().map((key) => key.key)).toEqual(['b']);

    const crowded = collect(target, () => clock);
    for (let n = 0; n < 40; n += 1) press(target, 'x');
    expect(crowded.take()).toHaveLength(16);
  });
});

describe('the shell and a key pressed before it mounted', () => {
  const stores: AppStore[] = [];
  afterEach(async () => {
    delete window.eeEarlyKeys;
    for (const store of stores.splice(0)) await store.dispose();
  });

  it('acts on the key once the handler is there: G opens the Library', async () => {
    const fake = createFakeBridge({ photos: mockPhotos() });
    window.eeTransport = fake.transport;
    const target = new EventTarget();
    const early = collect(target);
    // Before the shell exists: nothing hears this key but the preload's collector.
    press(target, 'g');
    window.eeEarlyKeys = early;

    const store = createAppStore(fake.bridge, {
      renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    });
    stores.push(store);
    render(<App store={store} />);
    await screen.findByTestId('library-view');
    expect(store.getState().module).toBe('library');
  });

  it('does nothing when no key was pressed early', async () => {
    const fake = createFakeBridge({ photos: mockPhotos() });
    window.eeTransport = fake.transport;
    window.eeEarlyKeys = collect(new EventTarget());
    const store = createAppStore(fake.bridge, {
      renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    });
    stores.push(store);
    render(<App store={store} />);
    await screen.findByTestId('film-strip');
    expect(store.getState().module).toBe('develop');
  });
});
