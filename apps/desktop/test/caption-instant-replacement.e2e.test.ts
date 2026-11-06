// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { asSourceId, type IngestConfig, type IpcResult, type Photo } from '@ee/contracts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyInto, fixtureNefs, repoRoot } from './helpers/fixtures';

/**
 * Code replacement while typing the caption, in the built app (real mode) with real key presses:
 * a code is replaced when its closing delimiter is typed, the caret stays after it, Ctrl+Z gives
 * back what was typed, and Ctrl+Space keeps the caret with the text. The codes are a real
 * tab-delimited file that the jobs process serves.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const nefs = fixtureNefs().slice(0, 1);
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 250 + (process.pid % 40);
  while (existsSync(`/tmp/.X11-unix/X${number}`)) number += 1;
  const child: ChildProcess = spawn(
    'Xvfb',
    [`:${number}`, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${number}`); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { env: { DISPLAY: `:${number}` }, stop: () => void child.kill() };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

describe.skipIf(nefs.length < 1 || !haveDisplay)(
  'instant code replacement in the caption (real Electron app)',
  () => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    let root: string;
    const dir = (name: string): string => join(root, name);
    const codesFile = (): string => join(dir('codes'), 'sportfotografen.txt');
    const latin1File = (): string => join(dir('codes'), 'latin1.tsv');
    const columnsFile = (): string => join(dir('codes'), 'columns.tsv');

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
      const typed = result as IpcResult<T>;
      if (!typed.ok) throw new Error(`${channel}: ${typed.error.code}: ${typed.error.message}`);
      return typed.value;
    };

    const caption = () => window.locator('[data-caption-input]');
    const state = () =>
      caption().evaluate((element) => {
        const area = element as HTMLTextAreaElement;
        return { value: area.value, start: area.selectionStart, end: area.selectionEnd };
      });
    /** Focus the caption and empty it. */
    const startOver = async (): Promise<void> => {
      await caption().click();
      await window.keyboard.press('Control+a');
      await window.keyboard.press('Delete');
      expect((await state()).value).toBe('');
    };

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-caption-e2e-'));
      for (const name of ['card', 'ingest', 'codes']) mkdirSync(dir(name));
      copyInto(nefs[0]!, join(dir('card'), 'game_1.NEF'));
      writeFileSync(codesFile(), 't1\tGAIS\nÅ1\tÅngelholm\nlast\t{filename}\n', 'utf8');
      // A Latin-1 file: Å is the single byte 0xC5, which is not valid UTF-8.
      writeFileSync(latin1File(), Buffer.from('\xc5MAL\t\xc5sa Svensson\n', 'latin1'));
      // A .tsv with three columns, for =code#N=.
      writeFileSync(columnsFile(), 'a10\tAlfa\tBravo\tCharlie\n', 'utf8');
      display = await ensureDisplay();

      const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
      app = await electron.launch({
        executablePath: electronPath,
        args: [desktopDir],
        env: {
          ...(process.env as Record<string, string>),
          ...display.env,
          EE_MOCK: '',
          EE_USER_DATA_DIR: dir('userdata'),
          EE_TRASH_DIR: dir('trash'),
        },
      });
      window = await app.firstWindow();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

      const { ingest } = await invoke<{ ingest: IngestConfig }>('settings:get');
      await invoke('settings:set', {
        ingest: { ...ingest, destination: { path: dir('ingest') } },
        codeReplacementPaths: [codesFile(), latin1File(), columnsFile()],
      });
      await invoke('ingest:start', {
        config: {
          ...ingest,
          sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: dir('card') }],
          destination: { path: dir('ingest') },
          fileNaming: 'keep',
          renameTemplate: '{filenamebase}',
        },
      });
      await until('the photo', async () => (await invoke<Photo[]>('photos:list')).length === 1);
      await window.getByRole('tab', { name: 'Develop' }).click();
      await window.locator('button[title^="game_1.NEF"]').click();
      await caption().waitFor();
    }, 300_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }, 60_000);

    it('replaces a code on the closing delimiter, leaves the caret after it, and undoes to what was typed', async () => {
      await startOver();
      await window.keyboard.type('Goal for =t1');
      expect(await state()).toMatchObject({ value: 'Goal for =t1' });

      await window.keyboard.press('=');
      expect(await state()).toEqual({ value: 'Goal for GAIS', start: 13, end: 13 });

      await window.keyboard.type(' scores');
      expect((await state()).value).toBe('Goal for GAIS scores');

      // Undo gives back the typed code (how many presses the typing after it takes is up to the
      // browser, which groups typed characters), and the stack still works after that.
      const seen: string[] = [];
      for (let presses = 0; presses < 12 && !seen.includes('Goal for =t1='); presses++) {
        await window.keyboard.press('Control+z');
        seen.push((await state()).value);
      }
      expect(seen.at(-1)).toBe('Goal for =t1=');
      expect(seen).toContain('Goal for GAIS');
      await window.keyboard.press('Control+z');
      expect((await state()).value.length).toBeLessThan('Goal for =t1='.length);
      await window.keyboard.press('Control+Shift+z');
      expect((await state()).value).toBe('Goal for =t1=');
    });

    it('leaves what does not match alone and handles Å', async () => {
      await startOver();
      await window.keyboard.type('a=b =zz= =T1= =x=');
      expect((await state()).value).toBe('a=b =zz= =T1= =x=');

      await window.keyboard.type(' =Å1=');
      expect((await state()).value).toBe('a=b =zz= =T1= =x= Ångelholm');
    });

    it('keeps the caret after the replacement when there is text after it', async () => {
      await startOver();
      await window.keyboard.type('Goal by Foo');
      for (let i = 0; i < 7; i++) await window.keyboard.press('ArrowLeft');
      await window.keyboard.type('=t1=');

      const now = await state();
      expect(now.value).toBe('GoalGAIS by Foo');
      expect(now.start).toBe('GoalGAIS'.length);
    });

    it('expands a token with no match once an edit inside it makes a known code', async () => {
      await startOver();
      await window.keyboard.type('Goal =foo= more');
      expect((await state()).value).toBe('Goal =foo= more');
      for (let i = 0; i < ' more'.length + 1; i++) await window.keyboard.press('ArrowLeft');
      for (let i = 0; i < 3; i++) await window.keyboard.press('Backspace');
      await window.keyboard.type('t1');

      expect(await state()).toEqual({ value: 'Goal GAIS more', start: 9, end: 9 });
    });

    it('expands from Backspace in =t1x= and from Delete in =xt1=', async () => {
      await startOver();
      await window.keyboard.insertText('=t1x= later');
      for (let i = 0; i < ' later'.length + 1; i++) await window.keyboard.press('ArrowLeft');
      await window.keyboard.press('Backspace');
      expect(await state()).toEqual({ value: 'GAIS later', start: 4, end: 4 });

      await startOver();
      await window.keyboard.insertText('=xt1= later');
      await window.keyboard.press('Home');
      await window.keyboard.press('ArrowRight');
      await window.keyboard.press('Delete');
      expect(await state()).toEqual({ value: 'GAIS later', start: 4, end: 4 });
    });

    it('expands when an opening delimiter is typed in front of t1=', async () => {
      await startOver();
      await window.keyboard.insertText('t1= and more');
      await window.keyboard.press('Home');
      await window.keyboard.press('=');
      expect(await state()).toEqual({ value: 'GAIS and more', start: 4, end: 4 });
    });

    it('does not expand a=b c=d, and expands nothing after an undo until the next edit', async () => {
      await startOver();
      await window.keyboard.type('a=b c=d');
      await window.keyboard.press('ArrowLeft');
      await window.keyboard.type('x');
      await window.keyboard.press('Backspace');
      expect((await state()).value).toBe('a=b c=d');

      await startOver();
      await window.keyboard.type('Goal =t1=');
      expect((await state()).value).toBe('Goal GAIS');
      // Ctrl+Z gives back =t1=; the undo itself expands nothing, and neither does moving around.
      await window.keyboard.press('Control+z');
      expect((await state()).value).toBe('Goal =t1=');
      await window.keyboard.press('ArrowLeft');
      await window.keyboard.press('ArrowRight');
      await sleep(300);
      expect((await state()).value).toBe('Goal =t1=');
      // Redo is not a typed edit either.
      await window.keyboard.press('Control+Shift+z');
      expect((await state()).value).toBe('Goal GAIS');
      await window.keyboard.press('Control+z');
      expect((await state()).value).toBe('Goal =t1=');
      // The next typed edit that leaves an exact known code expands it.
      await window.keyboard.press('End');
      await window.keyboard.press('ArrowLeft');
      await window.keyboard.type('x');
      expect((await state()).value).toBe('Goal =t1x=');
      await window.keyboard.press('Backspace');
      expect((await state()).value).toBe('Goal GAIS');
    });

    it('replaces =a10#2= with the second column of a .tsv, and a missing column once it is edited', async () => {
      await startOver();
      // # is Shift+3 on a Swedish keyboard: the key is "#" with Shift held, as it is typed here.
      await window.keyboard.type('=a10');
      await window.keyboard.down('Shift');
      await window.keyboard.press('#');
      await window.keyboard.up('Shift');
      await window.keyboard.type('2');
      expect((await state()).value).toBe('=a10#2');
      await window.keyboard.press('=');
      expect(await state()).toEqual({ value: 'Bravo', start: 5, end: 5 });

      await window.keyboard.type(' =a10#1= =a10=');
      expect((await state()).value).toBe('Bravo Alfa Alfa');

      await startOver();
      await window.keyboard.type('=a10#9=');
      expect((await state()).value).toBe('=a10#9=');
      await window.keyboard.press('ArrowLeft');
      await window.keyboard.press('Backspace');
      await window.keyboard.type('2');
      expect(await state()).toEqual({ value: 'Bravo', start: 5, end: 5 });
    });

    it('reads a Latin-1 file the way blur does, so Å is not garbled', async () => {
      await startOver();
      await window.keyboard.type('=');
      await window.keyboard.insertText('ÅMAL');
      await window.keyboard.press('=');
      expect((await state()).value).toBe('Åsa Svensson');
    });

    it('does not replace inserted text: it waits for blur', async () => {
      await startOver();
      // One insertion of several characters, as a paste is.
      await window.keyboard.insertText('Goal =t1=');
      expect((await state()).value).toBe('Goal =t1=');
      await window.keyboard.press('Tab');
      await until('blur to expand', async () => (await state()).value === 'Goal GAIS' || false);
    });

    it('reads a file that changed on disk the next time the caption gets focus', async () => {
      await startOver();
      await window.keyboard.type('=t7=');
      expect((await state()).value).toBe('=t7=');

      writeFileSync(codesFile(), 't1\tGAIS\nt7\tHammarby\n', 'utf8');
      // Make the modified time differ even on a file system with coarse timestamps.
      const later = new Date(Date.now() + 5000);
      (await import('node:fs')).utimesSync(codesFile(), later, later);
      await window.keyboard.press('Tab');
      await startOver();
      await window.keyboard.type('=t7=');
      expect((await state()).value).toBe('Hammarby');
    });

    it('keeps the caret with the text on Ctrl+Space', async () => {
      await startOver();
      await window.keyboard.insertText('Goal =t1= by {filename} end');
      for (let i = 0; i < ' by {filename} end'.length; i++)
        await window.keyboard.press('ArrowLeft');
      await window.keyboard.press('Control+Space');

      await until('the caption to expand', async () => (await state()).value.includes('game_1'));
      const now = await state();
      expect(now.value).toBe('Goal GAIS by game_1.NEF end');
      expect(now.value.slice(0, now.start)).toBe('Goal GAIS');
      expect(now.value.slice(now.start)).toBe(' by game_1.NEF end');
    });

    it('saves the replaced caption to the photo', async () => {
      await startOver();
      await window.keyboard.type('Final =t1=');
      const [photo] = await invoke<Photo[]>('photos:list');
      await until('the caption on disk', async () => {
        const fields = await invoke<{ caption?: string }>('metadata:read', { photoId: photo!.id });
        return fields.caption === 'Final GAIS';
      });
    });
  },
);
