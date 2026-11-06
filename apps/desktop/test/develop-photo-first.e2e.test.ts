// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * The Develop view in the real app with the mock backend, at 1440 × 873 and driven with a real mouse
 * (Playwright clicks are trusted pointer input): the photo has the room the bottom bar used to take,
 * and every control that moved is where it moved to.
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
  let number = 200 + (process.pid % 40);
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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe.skipIf(!haveDisplay)(
  'Develop, photo first (real Electron app)',
  { timeout: 240_000 },
  () => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    const problems: string[] = [];

    const box = async (selector: string): Promise<Box> => {
      const found = await window.locator(selector).first().boundingBox();
      if (!found) throw new Error(`${selector} is not on screen`);
      return found;
    };
    const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      const result = await window.evaluate(
        ([name, params]) =>
          (
            window as unknown as {
              eeTransport: { invoke(c: string, a: unknown[]): Promise<unknown> };
            }
          ).eeTransport.invoke(name as string, params as unknown[]),
        [channel, args] as const,
      );
      const typed = result as { ok: boolean; value?: T; error?: { message: string } };
      if (!typed.ok) throw new Error(`${channel}: ${typed.error?.message ?? 'failed'}`);
      return typed.value as T;
    };
    const stageBox = (): Promise<Box> => box('[data-testid="photo-canvas"] [data-photo-id]');
    const resizeWindow = async (width: number, height: number): Promise<void> => {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
        },
        { width, height },
      );
      await window.waitForFunction(
        (size) => innerWidth === size.width && innerHeight === size.height,
        { width, height },
      );
    };
    /** Drag a side panel's handle until its own width reports the requested pixels. */
    const resizePanel = async (panel: string, width: number): Promise<void> => {
      const handle = window.getByTestId(`panel-resize-${panel}`);
      const at = await handle.boundingBox();
      if (!at) throw new Error(`no handle for ${panel}`);
      const current = Number(await handle.getAttribute('aria-valuenow'));
      const x = at.x + at.width / 2;
      const y = at.y + at.height / 2;
      await window.mouse.move(x, y);
      await window.mouse.down();
      await window.mouse.move(x + width - current, y, { steps: 8 });
      await window.mouse.up();
      await window.waitForFunction(
        ([testId, expected]) =>
          Number(
            document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-valuenow'),
          ) === expected,
        [`panel-resize-${panel}`, width] as const,
      );
    };
    const activeName = (): Promise<string | null> =>
      window.locator('[data-testid="film-strip"] [aria-selected="true"] img').getAttribute('alt');
    const selectPhoto = async (fileName: string): Promise<void> => {
      await window.locator(`[data-testid="film-strip"] button[title^="${fileName}"]`).click();
      await window.waitForFunction(
        (name) =>
          document
            .querySelector(`[data-testid="film-strip"] button[title^="${name}"]`)
            ?.getAttribute('aria-selected') === 'true',
        fileName,
      );
    };
    const settle = async (): Promise<void> => {
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]');
    };
    const sliderValue = (label: string): Promise<string> =>
      window.getByLabel(`${label} value`, { exact: true }).first().inputValue();
    /** A click on the photo moves the focus off any field, so the single-key shortcuts apply. */
    const focusPhoto = async (): Promise<void> => {
      await window.locator('[data-testid="photo-canvas"] [data-photo-id]').click();
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
      window.on('console', (message) => {
        if (message.type() === 'error') problems.push(message.text());
      });
      window.on('pageerror', (error) => problems.push(error.message));
      // A template whose name is too long for the panel: it must truncate, not push Apply.
      const settings = await invoke<{
        ingest: Record<string, unknown>;
        metadataTemplates: string[];
      }>('settings:get');
      const longTemplate =
        '/mock/templates/2026-10-24 IFK–AIK — Premier League — Sportfotografen.XMP';
      await invoke('settings:set', {
        ...settings,
        ingest: { ...settings.ingest, metadataTemplatePath: longTemplate },
        metadataTemplates: [longTemplate, ...settings.metadataTemplates],
      });
      await window.reload();
      await window.waitForFunction(() => 'eeTransport' in window);
      await resizeWindow(1440, 873);
      await window.waitForFunction(() => {
        const images = [...document.querySelectorAll('[data-testid="film-strip"] img')];
        return images.length > 0 && images.every((image) => (image as HTMLImageElement).complete);
      });
      await window.locator('[data-testid="develop-view"]').waitFor();
      await selectPhoto('_DSC8334.NEF');
      await settle();
    }, 180_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
    }, 60_000);

    it('gives the photo at least 840 px at 1440 × 873, and has no bottom bar', async () => {
      const stage = await stageBox();
      expect(stage.width).toBeGreaterThanOrEqual(840);
      // The 3:2 photo keeps its shape.
      expect(stage.width / stage.height).toBeCloseTo(1.5, 1);

      // Nothing is below the film strip, and the only footer in the view is the photo's own.
      const strips = await box('[data-testid="develop-strips"]');
      expect(strips.y + strips.height).toBeGreaterThanOrEqual(872);
      expect(
        await window
          .locator('[data-testid="develop-view"] footer')
          .evaluateAll((footers) =>
            footers.map((footer) => footer.closest('[data-testid="photo-view"]') !== null),
          ),
      ).toEqual([true]);
      // No panel titles.
      for (const id of ['metadata-panel', 'develop-panel']) {
        expect(
          await window.locator(`[data-testid="${id}"] header`).first().textContent(),
        ).not.toMatch(/^(metadata|develop)$/i);
      }
    });

    it('has Export… and Next & send in the filter row, and Next & send moves on', async () => {
      const bar = await box('[data-testid="filter-bar"]');
      for (const id of ['open-export', 'next-send']) {
        const button = await box(`[data-testid="${id}"]`);
        expect(button.y).toBeGreaterThanOrEqual(bar.y);
        expect(button.y + button.height).toBeLessThanOrEqual(bar.y + bar.height + 1);
        expect(button.x + button.width).toBeLessThanOrEqual(bar.x + bar.width);
      }
      // The summary the bottom bar used to print is the button's tooltip.
      expect(await window.getByTestId('next-send').getAttribute('title')).toMatch(/q\d+ → .+ → /);

      await window.getByTestId('open-export').click();
      await window.getByTestId('export-dialog').waitFor();
      await window.keyboard.press('Escape');
      await window.getByTestId('export-dialog').waitFor({ state: 'detached' });

      const before = await activeName();
      await window.getByTestId('next-send').click();
      await window.waitForFunction((name) => {
        const current = document
          .querySelector('[data-testid="film-strip"] [aria-selected="true"] img')
          ?.getAttribute('alt');
        return current !== undefined && current !== name;
      }, before);
      await selectPhoto('_DSC8334.NEF');
      await settle();
    });

    it('sends with Ctrl+Enter while Tab has hidden the filter row', async () => {
      await focusPhoto();
      await window.keyboard.press('Tab');
      await window.locator('[data-testid="develop-strips"]').waitFor({ state: 'hidden' });
      const before = await activeName();
      await window.keyboard.press('Control+Enter');
      await window.keyboard.press('Tab');
      await window.locator('[data-testid="develop-strips"]').waitFor();
      await window.waitForFunction((name) => {
        const current = document
          .querySelector('[data-testid="film-strip"] [aria-selected="true"] img')
          ?.getAttribute('alt');
        return current !== undefined && current !== name;
      }, before);
      await selectPhoto('_DSC8334.NEF');
      await settle();
    });

    it('has Auto and Pick in the White balance header and Auto in the Tone header', async () => {
      const wb = await box('[data-testid="white-balance"]');
      for (const id of ['auto-wb', 'wb-picker']) {
        const button = await box(`[data-testid="${id}"]`);
        expect(button.y).toBeGreaterThanOrEqual(wb.y);
        expect(button.y + button.height).toBeLessThanOrEqual(wb.y + 30);
      }
      expect(await window.getByTestId('auto-wb').textContent()).toBe('Auto');
      expect(await window.getByTestId('wb-picker').textContent()).toBe('Pick');
      const tone = await window
        .getByRole('switch', { name: 'Tone on or off' })
        .evaluate((element) => element.closest('header')?.getBoundingClientRect().toJSON());
      const auto = await box('[data-testid="auto-tone"]');
      expect(auto.y).toBeGreaterThanOrEqual(tone.y);
      expect(auto.y + auto.height).toBeLessThanOrEqual(tone.y + tone.height);

      // Auto tone moves the tone sliders, from the Tone header.
      const exposure = await sliderValue('Exposure');
      await window.getByTestId('auto-tone').click();
      await window.waitForFunction(
        ([label, value]) =>
          (document.querySelector(`[aria-label="${label} value"]`) as HTMLInputElement | null)
            ?.value !== value,
        ['Exposure', exposure] as const,
      );

      // The picker opens its layer on the photo, and Escape closes it.
      await window.getByTestId('wb-picker').click();
      await window.locator('[data-testid="wb-picker-layer"]').waitFor();
      expect(await window.getByTestId('wb-picker').getAttribute('aria-pressed')).toBe('true');
      await window.keyboard.press('Escape');
      await window.locator('[data-testid="wb-picker-layer"]').waitFor({ state: 'detached' });

      // Auto WB sets a temperature and tint of its own.
      await window.getByTestId('auto-wb').click();
      await settle();
      await window.getByRole('switch', { name: 'White balance on or off' }).waitFor();
      await window.getByLabel('Temperature value').waitFor();
    });

    it('has Before and Split in the photo footer', async () => {
      const footer = await box('[data-testid="photo-view"] footer');
      const labels = await window
        .locator('[data-testid="photo-view"] footer button')
        .evaluateAll((buttons) => buttons.map((button) => button.textContent));
      expect(labels.slice(0, 4).map((label) => label?.trim())).toEqual([
        'Crop',
        'Retouch',
        'Before',
        'Split',
      ]);
      for (const id of ['before-after', 'split-view']) {
        const button = await box(`[data-testid="${id}"]`);
        expect(button.y).toBeGreaterThanOrEqual(footer.y);
        expect(button.y + button.height).toBeLessThanOrEqual(footer.y + footer.height);
      }

      await window.getByTestId('split-view').click();
      await window.locator('[data-testid="split-divider"]').waitFor();
      await window.getByTestId('split-view').click();
      await window.locator('[data-testid="split-divider"]').waitFor({ state: 'detached' });

      await window.getByTestId('before-after').click();
      expect(await window.getByTestId('before-after').getAttribute('aria-pressed')).toBe('true');
      await window.getByTestId('before-after').click();
      expect(await window.getByTestId('before-after').getAttribute('aria-pressed')).toBe('false');
      // Y still toggles it, with the focus on the photo.
      await focusPhoto();
      await window.keyboard.press('y');
      expect(await window.getByTestId('before-after').getAttribute('aria-pressed')).toBe('true');
      await window.keyboard.press('y');
    });

    it('applies a preset from the one-row menu', async () => {
      const row = await box('[data-testid="preset-row"]');
      expect(row.height).toBeLessThan(34);
      await window.getByTestId('preset-menu').getByRole('button').click();
      const list = window.getByTestId('presets');
      await list.waitFor();
      // The groups and their counts are in the menu, and so are Refresh and Import.
      expect(await list.getByTestId('preset-group').count()).toBeGreaterThan(0);
      await window.getByRole('button', { name: 'Refresh presets' }).waitFor();
      await window.getByRole('menuitem', { name: /Import/ }).waitFor();

      const contrast = await sliderValue('Contrast');
      await list.getByText('Press — Punchy').click();
      await list.waitFor({ state: 'detached' });
      await window.waitForFunction(
        (before) =>
          (document.querySelector('[aria-label="Contrast value"]') as HTMLInputElement | null)
            ?.value !== before,
        contrast,
      );
      expect(await sliderValue('Contrast')).toBe('15');
    });

    it('folds Credits, Location and Event / job, with a summary and a visible template difference', async () => {
      // Photo 5 has another city and location than the template.
      const location = window.getByTestId('metadata-group-location');
      await location.waitFor();
      expect(await location.getByRole('button', { expanded: false }).count()).toBe(1);
      const differs = location.getByTestId('metadata-group-differs');
      expect(await differs.isVisible()).toBe(true);
      expect(await differs.textContent()).toBe('≠ template');
      expect(await differs.getAttribute('title')).toContain('City (template: Manchester)');
      const summary = location.getByTestId('metadata-group-summary');
      expect(await summary.textContent()).toContain('Liverpool');
      // The difference and the summary are on the header, inside the panel.
      const header = await location.getByRole('button').boundingBox();
      const mark = await differs.boundingBox();
      const panel = await box('[data-testid="metadata-panel"]');
      if (!header || !mark) throw new Error('no header');
      expect(mark.x).toBeGreaterThanOrEqual(panel.x);
      expect(mark.x + mark.width).toBeLessThanOrEqual(panel.x + panel.width);
      expect(Math.abs(mark.y - header.y)).toBeLessThan(header.height);

      expect(
        await window
          .getByTestId('metadata-group-credits')
          .getByText('Byline', { exact: true })
          .count(),
      ).toBe(0);
      await window.getByTestId('metadata-group-credits').getByRole('button').first().click();
      await window
        .getByTestId('metadata-group-credits')
        .getByText('Byline', { exact: true })
        .waitFor();
      await window.getByTestId('metadata-group-credits').getByRole('button').first().click();
      expect(
        await window
          .getByTestId('metadata-group-credits')
          .getByText('Byline', { exact: true })
          .count(),
      ).toBe(0);
    });

    it('puts the caption near the top of the panel, ahead of keywords and headline', async () => {
      const panel = await box('[data-testid="metadata-panel"]');
      const caption = await box('[data-caption-input]');
      const keywords = await box('[data-keywords-input]');
      expect(caption.y - panel.y).toBeLessThan(110);
      expect(caption.height).toBeGreaterThanOrEqual(100);
      expect(keywords.y).toBeGreaterThan(caption.y + caption.height);
      const headline = await window
        .locator('[data-testid="metadata-fields"] label', { hasText: 'Headline' })
        .boundingBox();
      expect(headline?.y ?? 0).toBeGreaterThan(keywords.y);
    });

    it('keeps Ctrl+I and Ctrl+K working with the groups folded', async () => {
      await focusPhoto();
      await window.keyboard.press('Control+i');
      expect(
        await window.evaluate(() => document.activeElement?.hasAttribute('data-caption-input')),
      ).toBe(true);
      await window.keyboard.press('Control+k');
      expect(
        await window.evaluate(() => document.activeElement?.hasAttribute('data-keywords-input')),
      ).toBe(true);
      await window.keyboard.press('Escape');
    });

    it('has Copy settings in the Develop panel first', async () => {
      const copy = await box('[data-testid="open-copy-settings"]');
      const panel = await box('[data-testid="develop-panel"]');
      expect(copy.y - panel.y).toBeLessThan(40);
      await window.getByTestId('open-copy-settings').click();
      await window.getByTestId('copy-settings-dialog').waitFor();
      await window.keyboard.press('Escape');
      await window.getByTestId('copy-settings-dialog').waitFor({ state: 'detached' });
    });

    it('puts the template and Apply on one row and Copy/Paste below at 260, 280 and wide', async () => {
      const longTemplate =
        '/mock/templates/2026-10-24 IFK–AIK — Premier League — Sportfotografen.XMP';
      for (const width of [260, 280, 500]) {
        await resizePanel('develop-metadata', width);
        await settle();
        const panel = await box('[data-testid="metadata-panel"]');
        const toolbar = await box('[data-testid="metadata-toolbar"]');
        const templateRow = await box('[data-testid="metadata-template-row"]');
        const copyRow = await box('[data-testid="metadata-copy-row"]');
        const select = await box('[data-testid="metadata-template-select"]');
        const apply = await box('[data-testid="metadata-template-apply"]');
        const copy = await box('[data-testid="metadata-copy"]');
        const paste = await box('[data-testid="metadata-paste"]');

        // Two rows, and the clipboard actions are on the second one, on the left.
        expect(templateRow.y + templateRow.height).toBeLessThanOrEqual(copyRow.y);
        expect(copyRow.y).toBeGreaterThan(templateRow.y);
        expect(copy.x).toBeCloseTo(select.x, 0);
        expect(paste.x).toBeGreaterThan(copy.x + copy.width);
        expect(paste.x + paste.width).toBeLessThanOrEqual(panel.x + panel.width);
        // The select takes the free width and Apply with its menu sits at the right edge.
        expect(select.x + select.width).toBeLessThanOrEqual(apply.x);
        expect(apply.y).toBeGreaterThanOrEqual(templateRow.y);
        expect(apply.y + apply.height).toBeLessThanOrEqual(templateRow.y + templateRow.height);
        expect(apply.x + apply.width).toBeLessThanOrEqual(panel.x + panel.width - 11);
        expect(toolbar.height).toBeGreaterThan(40);
        expect(toolbar.height).toBeLessThan(70);

        // Nothing wraps or clips inside a button.
        const wrapped = await window
          .locator('[data-testid="metadata-toolbar"] button')
          .evaluateAll((buttons) =>
            buttons
              .filter(
                (button) =>
                  button.scrollWidth > button.clientWidth + 1 ||
                  button.scrollHeight > button.clientHeight + 1,
              )
              .map((button) => button.textContent),
          );
        expect(wrapped).toEqual([]);

        // The long name is what is selected, truncates with an ellipsis, and has the full path
        // in its tooltip.
        const template = await window
          .getByTestId('metadata-template-select')
          .evaluate((element) => {
            const select = element as HTMLSelectElement;
            const text = select.options[select.selectedIndex]?.text ?? '';
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (context) context.font = getComputedStyle(select).font;
            return {
              text,
              title: select.getAttribute('title'),
              ellipsis: getComputedStyle(select).textOverflow,
              needsTruncation: context
                ? context.measureText(text).width > select.clientWidth
                : true,
            };
          });
        expect(template.text).toContain('2026-10-24 IFK–AIK');
        expect(template.title).toBe(longTemplate);
        expect(template.ellipsis).toBe('ellipsis');
        if (width <= 280) expect(template.needsTruncation).toBe(true);
      }
      await resizePanel('develop-metadata', 280);
    });

    it('keeps the footer on one line at 1440 and at 1024, dropping the lens first', async () => {
      const read = () =>
        window.locator('[data-testid="photo-view"] footer').evaluate((footer) => {
          const rect = footer.getBoundingClientRect();
          const info = footer.querySelector<HTMLElement>('[data-testid="photo-info"]');
          const infoRect = info?.getBoundingClientRect();
          const items = [...(info?.children ?? [])].map((child) => {
            const at = child.getBoundingClientRect();
            return {
              text: child.textContent ?? '',
              shown: at.top >= rect.top && at.bottom <= rect.bottom + 1,
              cut: (child as HTMLElement).scrollWidth > (child as HTMLElement).clientWidth,
              inside: infoRect !== undefined && at.right <= infoRect.right + 0.5,
            };
          });
          return {
            height: rect.height,
            buttonTops: [...footer.querySelectorAll('button')].map((button) =>
              Math.round(button.getBoundingClientRect().top),
            ),
            items,
            title: info?.getAttribute('title') ?? '',
          };
        });
      for (const width of [1440, 1024]) {
        await resizeWindow(width, 800);
        await settle();
        const footer = await read();
        expect(footer.height).toBeLessThan(34);
        expect(new Set(footer.buttonTops).size).toBe(1);
        // Whatever is shown is whole; the name always is.
        expect(footer.items[0]?.shown).toBe(true);
        for (const item of footer.items.filter((candidate) => candidate.shown)) {
          expect(item.cut).toBe(false);
          expect(item.inside).toBe(true);
        }
        // What does not fit drops out last first: nothing after a dropped item is shown.
        const shownFlags = footer.items.map((item) => item.shown);
        expect(shownFlags).toEqual([...shownFlags].sort((a, b) => Number(b) - Number(a)));
        // The tooltip has all of it, shown or not.
        expect(footer.title.split('\n')).toEqual(footer.items.map((item) => item.text));
      }
      // At 1440 the name, size, camera and time are all there.
      await resizeWindow(1440, 873);
      await settle();
      const wide = await read();
      expect(wide.items.slice(0, 4).every((item) => item.shown)).toBe(true);
    });

    it('logs no errors', () => {
      expect(problems).toEqual([]);
    });
  },
);
