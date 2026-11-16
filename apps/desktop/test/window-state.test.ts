import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  placeWindow,
  readWindowState,
  writeWindowState,
  type WindowState,
} from '../src/main/window-state';

const defaults = { width: 1440, height: 900, minWidth: 960, minHeight: 600 };
const left = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 1920, height: 1040 };
const saved = (overrides: Partial<WindowState> = {}): WindowState => ({
  x: 100,
  y: 80,
  width: 1200,
  height: 800,
  maximized: false,
  ...overrides,
});

describe('window state file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ee-window-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips through its own file', () => {
    const file = join(dir, 'window-state.json');
    writeWindowState(file, saved({ maximized: true }));
    expect(readWindowState(file)).toEqual(saved({ maximized: true }));
  });

  it('is absent, empty or damaged without throwing', async () => {
    const file = join(dir, 'window-state.json');
    expect(readWindowState(file)).toBeUndefined();
    await writeFile(file, '{ not json');
    expect(readWindowState(file)).toBeUndefined();
    await writeFile(file, JSON.stringify({ x: 'left', y: 1, width: 1, height: 1 }));
    expect(readWindowState(file)).toBeUndefined();
    await writeFile(file, 'null');
    expect(readWindowState(file)).toBeUndefined();
  });

  it('never touches settings.json', async () => {
    const settings = join(dir, 'settings.json');
    await writeFile(settings, '{"a":1}');
    writeWindowState(join(dir, 'window-state.json'), saved());
    expect(await readFile(settings, 'utf8')).toBe('{"a":1}');
  });
});

describe('placeWindow', () => {
  it('opens at the default size and place on a first run', () => {
    expect(placeWindow(undefined, [left], defaults)).toEqual({
      width: 1440,
      height: 900,
      maximized: false,
    });
  });

  it('restores a saved rectangle that is on a display', () => {
    expect(placeWindow(saved(), [left], defaults)).toEqual({
      x: 100,
      y: 80,
      width: 1200,
      height: 800,
      maximized: false,
    });
  });

  it('restores a window on a second display while that display exists', () => {
    const onRight = saved({ x: 2100 });
    expect(placeWindow(onRight, [left, right], defaults).x).toBe(2100);
  });

  it('falls back to the default when the saved position is off every display', () => {
    expect(placeWindow(saved({ x: 2100 }), [left], defaults)).toEqual({
      width: 1440,
      height: 900,
      maximized: false,
    });
    expect(placeWindow(saved({ x: -5000, y: -5000 }), [left], defaults).x).toBeUndefined();
  });

  it('does not count a sliver at the edge of a display as visible', () => {
    // 40 px of the window is on the display: not enough to grab it.
    expect(placeWindow(saved({ x: 1880 }), [left], defaults).x).toBeUndefined();
  });

  it('keeps the maximised flag, also when the normal position is gone', () => {
    expect(placeWindow(saved({ maximized: true }), [left], defaults).maximized).toBe(true);
    expect(placeWindow(saved({ x: 9000, maximized: true }), [left], defaults).maximized).toBe(true);
  });

  it('never opens smaller than the minimum size', () => {
    const placed = placeWindow(saved({ width: 200, height: 100 }), [left], defaults);
    expect([placed.width, placed.height]).toEqual([960, 600]);
  });
});
