// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * Undo and redo in the built app with real key presses: a slider drag and a preset are two
 * steps, Ctrl+Z takes both back, Shift+Ctrl+Z puts one back, and Ctrl+Z in the caption field
 * leaves the develop settings alone.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 300 + (process.pid % 40);
  while (existsSync(`/tmp/.X11-unix/X${number}`)) number += 1;
  const child: ChildProcess = spawn(
    'Xvfb',
    [`:${number}`, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${number}`); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { env: { DISPLAY: `:${number}` }, stop: () => void child.kill() };
}

describe.skipIf(!haveDisplay)(
  'develop undo and redo (real Electron app)',
  { timeout: 240_000 },
  () => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;

    const sliderValue = (label: string): Promise<string> =>
      window.getByLabel(`${label} value`, { exact: true }).first().inputValue();

    const waitForSlider = async (label: string, value: string): Promise<void> => {
      await window.waitForFunction(
        ([name, expected]) =>
          (document.querySelector(`[aria-label="${name} value"]`) as HTMLInputElement | null)
            ?.value === expected,
        [label, value] as const,
      );
    };

    const selectPhoto = async (fileName: string): Promise<void> => {
      const target = window.locator(`[data-testid="film-strip"] button[title^="${fileName}"]`);
      if ((await target.count()) === 0) {
        await window.locator('[data-testid="film-strip"]').evaluate((element) => {
          element.scrollLeft = 0;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await window.waitForTimeout(200);
      }
      if ((await target.count()) === 0) {
        await window.locator('[data-testid="film-strip"]').evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await window.waitForTimeout(200);
      }
      await target.click();
      await window.waitForFunction(
        (name) =>
          document
            .querySelector(`[data-testid="film-strip"] button[title^="${name}"]`)
            ?.getAttribute('aria-selected') === 'true',
        fileName,
      );
      await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]');
    };

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      display = await ensureDisplay();
      const requireDesktop = createRequire(join(desktopDir, 'package.json'));
      app = await electron.launch({
        executablePath: requireDesktop('electron') as string,
        args: [desktopDir],
        env: {
          ...(process.env as Record<string, string>),
          ...display.env,
          EE_MOCK: '1',
          EE_SOFTWARE_GL: '1',
        },
      });
      window = await app.firstWindow();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.waitForFunction(() => {
        const images = [...document.querySelectorAll('[data-testid="film-strip"] img')];
        return images.length > 0 && images.every((image) => (image as HTMLImageElement).complete);
      });
      await window.locator('[data-testid="develop-view"]').waitFor();
      await selectPhoto('_DSC8334.NEF');
    }, 180_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
    }, 60_000);

    it('undoes a slider and a preset, redoes one, and leaves develop alone while typing a caption', async () => {
      // Drag Exposure with the mouse: the whole drag from pointer down to pointer up is one step.
      expect(await sliderValue('Exposure')).toBe('0');
      const exposure = window.getByRole('slider', { name: 'Exposure' });
      const track = await exposure.boundingBox();
      if (!track) throw new Error('no Exposure slider');
      const y = track.y + track.height / 2;
      await window.mouse.move(track.x + track.width * 0.2, y);
      await window.mouse.down();
      await window.mouse.move(track.x + track.width * 0.72, y, { steps: 20 });
      await window.mouse.up();
      await window.waitForFunction(
        () =>
          (document.querySelector('[aria-label="Exposure value"]') as HTMLInputElement | null)
            ?.value !== '0',
      );
      const dragged = await sliderValue('Exposure');

      // A preset is a second step.
      await window.getByTestId('preset-menu').getByRole('button').click();
      await window.getByTestId('presets').getByText('Press — Punchy').click();
      await waitForSlider('Contrast', '15');

      // Ctrl+Z twice: the preset, then the drag.
      await window.locator('[data-testid="photo-canvas"] [data-photo-id]').click();
      await window.keyboard.press('Control+z');
      await waitForSlider('Contrast', '0');
      expect(await sliderValue('Exposure')).toBe(dragged);
      await window.keyboard.press('Control+z');
      await waitForSlider('Exposure', '0');

      // Shift+Ctrl+Z redoes the drag only.
      await window.keyboard.press('Control+Shift+z');
      await waitForSlider('Exposure', dragged);
      expect(await sliderValue('Contrast')).toBe('0');

      // In the caption field Ctrl+Z is the field's own undo, not the develop history.
      const caption = window.locator('[data-caption-input]');
      const original = await caption.inputValue();
      await caption.click();
      await window.keyboard.press('End');
      await window.keyboard.type('X');
      expect(await caption.inputValue()).toBe(`${original}X`);
      await window.keyboard.press('Control+z');
      await window.waitForFunction(
        (value) =>
          (document.querySelector('[data-caption-input]') as HTMLTextAreaElement | null)?.value ===
          value,
        original,
      );
      expect(await sliderValue('Exposure')).toBe(dragged);
    });
  },
);
