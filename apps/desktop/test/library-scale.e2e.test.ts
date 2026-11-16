// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import sharp from 'sharp';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Photo, PhotoId } from '@ee/contracts';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { repoRoot } from './helpers/fixtures';

/**
 * A large Library in the built app: the folder tree loads without the photos, then one folder,
 * a filter, a selection, Develop and Remove folder from Library. The index is generated in a
 * throwaway userData folder, so nothing here depends on a camera or fixtures.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const haveDisplay =
  process.platform !== 'linux' || Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);
const FOLDERS = 5;
const PER_FOLDER = 600;
const TOTAL = FOLDERS * PER_FOLDER;

describe.skipIf(!haveDisplay)('Library scale (Electron)', () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;

  const sidebarRows = () => window.locator('[data-testid="library-folders"] li button');
  const countText = async (): Promise<string> =>
    (await window.getByTestId('filter-count').textContent())?.trim() ?? '';

  beforeAll(async () => {
    if (!existsSync(join(desktopDir, 'out', 'main', 'index.js'))) {
      throw new Error('Build the app first: pnpm build');
    }
    root = mkdtempSync(join(tmpdir(), 'ee-scale-e2e-'));
    const userData = join(root, 'userdata');
    const destination = join(root, 'Photos');
    mkdirSync(join(userData, 'cache', 'thumb'), { recursive: true });
    mkdirSync(join(userData, 'cache', 'preview'), { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(
      join(userData, 'machine.json'),
      JSON.stringify({
        version: 1,
        format: 'ee-machine',
        ingest: { destinationPath: destination },
        exportRoot: join(root, 'exports'),
        paths: {},
        sources: [],
        destinations: [],
      }),
    );

    const image = await sharp({
      create: { width: 160, height: 107, channels: 3, background: '#486a8c' },
    })
      .jpeg()
      .toBuffer();
    const index = new PhotoIndex(join(userData, 'index.sqlite'));
    for (let folder = 0; folder < FOLDERS; folder += 1) {
      const folderPath = join(destination, `2026-05-0${folder + 1} match-${folder + 1}`);
      for (let n = 0; n < PER_FOLDER; n += 1) {
        const id =
          `00000000-0000-4000-8000-${String(folder * PER_FOLDER + n).padStart(12, '0')}` as PhotoId;
        const path = join(folderPath, `_DSC${String(n + 1).padStart(4, '0')}.NEF`);
        const photo: Photo = {
          id,
          path,
          sidecarPath: path.replace(/\.NEF$/, '.xmp'),
          fileName: `_DSC${String(n + 1).padStart(4, '0')}.NEF`,
          captureTime: `2026-05-0${folder + 1}T12:${String(n % 60).padStart(2, '0')}:00`,
          camera: { make: 'NIKON CORPORATION', model: 'NIKON Z 9', serialNumber: '1' },
          sourceId: 'in-place' as Photo['sourceId'],
          tagged: n % 3 === 0,
          rating: n % 5 === 0 ? 4 : 0,
          colorClass: 0,
          status: {
            ingest: 'done',
            edited: false,
            metadataDiffersFromTemplate: false,
            export: 'none',
            upload: 'none',
          },
          versions: [],
        };
        index.save(photo);
        writeFileSync(join(userData, 'cache', 'thumb', `${id}.jpg`), image);
        writeFileSync(join(userData, 'cache', 'preview', `${id}.jpg`), image);
      }
    }
    index.close();
    const db = new DatabaseSync(join(userData, 'index.sqlite'));
    db.exec("UPDATE photos SET search_text = 'match report ' || file_name");
    db.close();

    app = await electron.launch({
      executablePath: createRequire(join(desktopDir, 'package.json'))('electron') as string,
      args: [desktopDir],
      env: {
        ...(process.env as Record<string, string>),
        EE_MOCK: '',
        EE_USER_DATA_DIR: userData,
      },
    });
    window = await app.firstWindow();
    window.setDefaultTimeout(30_000);
    await window.waitForFunction(
      () => document.querySelector('[data-store-ready="true"]') !== null,
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('opens a folder, filters, selects, opens Develop and removes another folder', async () => {
    await window.keyboard.press('g');
    await window.getByTestId('library-grid').waitFor();
    expect(await sidebarRows().first().textContent()).toContain(String(TOTAL));
    expect(await sidebarRows().count()).toBe(FOLDERS + 1);

    await sidebarRows().nth(1).click();
    await expect.poll(countText).toBe(String(PER_FOLDER));

    await window.locator('[role="group"][aria-label="Tag"] button').nth(1).click();
    await expect.poll(async () => (await countText()).split(' of ')[0]).toBe('200');
    await window.locator('[data-testid="library-cell"]').first().click();
    await window.keyboard.press('Control+a');
    await expect
      .poll(async () => (await window.getByTestId('library-selection-count').textContent())?.trim())
      .toBe('200 selected');
    await window.locator('[role="group"][aria-label="Tag"] button').first().click();

    await window.keyboard.press('d');
    await window.getByTestId('develop-view').waitFor();
    await window.getByTestId('film-strip').waitFor();
    await window.keyboard.press('g');
    await window.getByTestId('library-grid').waitFor();

    // Remove the second folder from the Library: files on disk are not touched.
    await sidebarRows().nth(2).click({ button: 'right' });
    await window.getByTestId('folder-menu-remove').click();
    const dialog = window.getByTestId('folder-remove-dialog');
    await dialog.waitFor();
    await window.getByTestId('folder-remove-subfolders').check();
    await window.getByTestId('folder-remove-confirm').click();
    await expect.poll(async () => sidebarRows().count()).toBe(FOLDERS);
    expect(await sidebarRows().first().textContent()).toContain(String(TOTAL - PER_FOLDER));
    expect(existsSync(join(root, 'Photos'))).toBe(true);
  });
});
