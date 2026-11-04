// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { IpcResult, Photo, SourceConfig } from '@ee/contracts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyInto, fixtureNefs, repoRoot } from './helpers/fixtures';

/**
 * Card discovery in the built app, real mode. `EE_CARD_ROOTS` points the scan at a temp
 * folder, so "inserting" a card is creating a folder with a DCIM directory in it and
 * "removing" it is deleting that folder. Nothing scans in the background: the Ingest view
 * scans when it opens and on the Rescan cards button.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const nef = fixtureNefs()[0];
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 200 + (process.pid % 50);
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

function insertCard(mountRoot: string, name: string, files: string[]): string {
  const mount = join(mountRoot, name);
  const folder = join(mount, 'DCIM', '100NCZ');
  mkdirSync(folder, { recursive: true });
  for (const file of files) writeFileSync(join(folder, file), 'not a real raw');
  return mount;
}

describe.skipIf(!haveDisplay)('card discovery (Electron)', { timeout: 60_000 }, () => {
  let app: ElectronApplication;
  let window: Page;
  let display: Awaited<ReturnType<typeof ensureDisplay>>;
  let root: string;
  let mountRoot: string;

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

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-cards-'));
    mountRoot = join(root, 'media');
    mkdirSync(mountRoot);
    insertCard(mountRoot, 'NIKON Z 6', ['_DSC0001.NEF', '_DSC0002.NEF']);

    display = await ensureDisplay();
    const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
    app = await electron.launch({
      executablePath: electronPath,
      args: [desktopDir],
      env: {
        ...(process.env as Record<string, string>),
        ...display.env,
        EE_MOCK: '',
        EE_CARD_ROOTS: mountRoot,
        EE_USER_DATA_DIR: join(root, 'userdata'),
      },
    });
    window = await app.firstWindow();
    await window.waitForFunction(() => 'eeTransport' in window);
    await window
      .getByTestId('status-bar')
      .getByRole('tab', { name: 'Ingest' })
      .click({ timeout: 60_000 });
    await window.getByTestId('ingest-view').waitFor();
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    display?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const cardRows = () => window.getByTestId('ingest-card');
  /** Nothing scans by itself: after a card is inserted or pulled, press the button. */
  const rescan = () => window.getByRole('button', { name: 'Rescan cards' }).click();

  it('lists the card that is in when the view opens, with its image count, and picks nothing', async () => {
    const row = cardRows().first();
    await row.waitFor({ timeout: 15_000 });
    await expect.poll(() => row.textContent(), { timeout: 15_000 }).toContain('2 images');
    expect(await row.textContent()).toContain('NIKON Z 6');
    expect(await row.textContent()).toContain(join(mountRoot, 'NIKON Z 6'));
    expect(await row.getByRole('checkbox', { name: 'NIKON Z 6' }).isChecked()).toBe(false);
    // Seeing a card never ingests it.
    expect(await invoke<Photo[]>('photos:list')).toEqual([]);
    expect(await invoke<SourceConfig[]>('sources:list')).toEqual([]);
  });

  it('does not notice a card on its own, shows it after Rescan cards, and drops a removed one', async () => {
    const second = insertCard(mountRoot, 'NIKON Z 61', ['_DSC0003.NEF']);
    // No background probing: well past the old 3 s interval the list is unchanged.
    await window.waitForTimeout(4_000);
    expect(await cardRows().count()).toBe(1);

    await rescan();
    await expect.poll(() => cardRows().count(), { timeout: 15_000 }).toBe(2);
    const labels = await cardRows().allTextContents();
    expect(labels.join('\n')).toContain(join(mountRoot, 'NIKON Z 61'));

    rmSync(second, { recursive: true, force: true });
    await rescan();
    await expect.poll(() => cardRows().count(), { timeout: 15_000 }).toBe(1);
  });

  it('counts the images again on a rescan', async () => {
    const folder = join(mountRoot, 'NIKON Z 6', 'DCIM', '100NCZ');
    writeFileSync(join(folder, '_DSC0099.NEF'), 'not a real raw');
    await rescan();
    await expect
      .poll(() => cardRows().first().textContent(), { timeout: 15_000 })
      .toContain('3 images');
    rmSync(join(folder, '_DSC0099.NEF'));
    await rescan();
    await expect
      .poll(() => cardRows().first().textContent(), { timeout: 15_000 })
      .toContain('2 images');
  });

  it('picks a card, keeps its filters, and a card put back keeps them', async () => {
    const row = cardRows().first();
    await row.getByRole('checkbox', { name: 'NIKON Z 6' }).check();
    const filters = row.getByTestId('source-filters');
    await filters.waitFor();
    await filters.getByRole('button', { name: 'RAW' }).click();
    await expect
      .poll(async () => (await invoke<SourceConfig[]>('sources:list'))[0], { timeout: 10_000 })
      .toMatchObject({ kind: 'card', discovered: true, fileTypes: 'raw', name: 'NIKON Z 6' });
    const [saved] = await invoke<SourceConfig[]>('sources:list');

    // Pull the card: the row goes, and the card comes back unpicked with the same source.
    rmSync(join(mountRoot, 'NIKON Z 6'), { recursive: true, force: true });
    await rescan();
    await expect.poll(() => cardRows().count(), { timeout: 15_000 }).toBe(0);
    insertCard(mountRoot, 'NIKON Z 6', ['_DSC0001.NEF', '_DSC0002.NEF']);
    await rescan();
    await expect.poll(() => cardRows().count(), { timeout: 15_000 }).toBe(1);
    const back = cardRows().first();
    expect(await back.getByRole('checkbox', { name: 'NIKON Z 6' }).isChecked()).toBe(false);
    await back.getByRole('checkbox', { name: 'NIKON Z 6' }).check();
    await back.getByTestId('source-filters').waitFor();
    expect(
      await back
        .getByTestId('source-filters')
        .getByRole('button', { name: 'RAW' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    const after = await invoke<SourceConfig[]>('sources:list');
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(saved?.id);
  });

  it.skipIf(!nef)(
    'a card pulled out before Ingest fails by name while the other picked card is ingested',
    async () => {
      const mount = insertCard(mountRoot, 'REAL CARD', []);
      copyInto(nef!, join(mount, 'DCIM', '100NCZ', 'DSC_0001.NEF'));
      await rescan();
      await expect.poll(() => cardRows().count(), { timeout: 15_000 }).toBe(2);
      // NIKON Z 6 is still ticked from the test above; tick the real one too.
      const real = cardRows().filter({ hasText: 'REAL CARD' });
      await real.getByRole('checkbox', { name: 'REAL CARD' }).check();
      await window.getByLabel('Destination folder').fill(join(root, 'ingest'));

      // Pull NIKON Z 6 without rescanning, then press Ingest.
      rmSync(join(mountRoot, 'NIKON Z 6'), { recursive: true, force: true });
      await window
        .getByTestId('ingest-view')
        .getByRole('button', { name: 'Ingest', exact: true })
        .click();

      await expect
        .poll(async () => (await invoke<Photo[]>('photos:list')).length, { timeout: 120_000 })
        .toBe(1);
      const sources = await invoke<SourceConfig[]>('sources:list');
      const realId = sources.find((source) => source.name === 'REAL CARD')?.id;
      expect((await invoke<Photo[]>('photos:list'))[0]?.sourceId).toBe(realId);
      // The pulled card's run says which card it was.
      await expect
        .poll(() => window.getByTestId('ingest-view').textContent(), { timeout: 15_000 })
        .toMatch(/Card "NIKON Z 6" is not available/);
    },
    150_000,
  );
});
