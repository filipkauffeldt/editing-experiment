// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { DetectedCard, IpcResult } from '@ee/contracts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * Launches the built app in real (non-mock) mode against a throwaway userData folder and asks the
 * jobs process two things that need no fixtures: which native core it loaded, and which cards it
 * can see. It is the check that the app starts on a platform at all (the Windows CI job runs it);
 * the photo pipeline is covered by `real-mode.smoke.test.ts`. Run `pnpm build` first.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const haveDisplay =
  process.platform !== 'linux' || Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);

describe.skipIf(!haveDisplay)('app launch (Electron)', () => {
  let app: ElectronApplication;
  let window: Page;
  let userData: string;

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
    if (!existsSync(join(desktopDir, 'out', 'main', 'index.js'))) {
      throw new Error('the app is not built: run `pnpm --filter @ee/desktop run build` first');
    }
    userData = mkdtempSync(join(tmpdir(), 'ee-launch-'));
    app = await electron.launch({
      executablePath: createRequire(join(desktopDir, 'package.json'))('electron') as string,
      args: [desktopDir],
      env: {
        ...(process.env as Record<string, string>),
        EE_MOCK: '',
        EE_USER_DATA_DIR: join(userData, 'userdata'),
      },
    });
    window = await app.firstWindow();
    await window.waitForFunction(() => 'eeTransport' in window);
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (userData) rmSync(userData, { recursive: true, force: true });
  }, 60_000);

  it('runs the real backend with the native core loaded in the jobs process', async () => {
    const info = await invoke<{ mock: boolean; coreVersion: string; platform: string }>(
      'system:info',
    );
    expect(info.mock).toBe(false);
    expect(info.coreVersion).toMatch(/^\d+\.\d+/);
    expect(info.platform).toBe(process.platform);
  });

  it('keeps its state below the folder it was given', async () => {
    await vi.waitFor(() =>
      expect(existsSync(join(userData, 'userdata', 'index.sqlite'))).toBe(true),
    );
  });

  it('scans for cards without failing, and never offers the system drive', async () => {
    const cards = await invoke<DetectedCard[]>('sources:detectCards', { waitForCounts: true });
    expect(Array.isArray(cards)).toBe(true);
    for (const card of cards) {
      expect(card.mountPath).not.toMatch(/^C:/i);
      expect(card.volumeLabel ?? '').not.toBe('');
    }
  });
});
