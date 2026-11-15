import { describe, expect, it, vi } from 'vitest';
import { applicationMenuTemplate } from '../src/main/menu-template';

type Entry = {
  role?: string;
  label?: string;
  accelerator?: string;
  click?: () => void;
  submenu?: Entry[];
};
const help = { about: vi.fn(), openLogFolder: vi.fn() };

const flatten = (entries: Entry[]): Entry[] =>
  entries.flatMap((entry) => [entry, ...flatten(entry.submenu ?? [])]);

describe('application menu', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    it(`has no page zoom entries on ${platform}, which would take Ctrl/Cmd + - and 0`, () => {
      const entries = flatten(applicationMenuTemplate(platform, help) as Entry[]);
      const roles = entries.map((entry) => entry.role);
      expect(roles).not.toContain('zoomIn');
      expect(roles).not.toContain('zoomOut');
      expect(roles).not.toContain('resetZoom');
      expect(roles).not.toContain('viewMenu');
      expect(entries.some((entry) => /zoom/i.test(entry.accelerator ?? ''))).toBe(false);
    });

    it(`keeps the edit, reload and DevTools roles on ${platform}`, () => {
      const roles = flatten(applicationMenuTemplate(platform, help) as Entry[]).map(
        (entry) => entry.role,
      );
      expect(roles).toContain('editMenu');
      expect(roles).toContain('reload');
      expect(roles).toContain('toggleDevTools');
    });
  }

  it('has a Help menu that opens the log folder and shows About, without shortcuts', () => {
    const menu = applicationMenuTemplate('linux', help) as Entry[];
    const entries = flatten(menu.filter((entry) => entry.role === 'help'));
    const open = entries.find((entry) => entry.label === 'Open log folder');
    open?.click?.();
    expect(help.openLogFolder).toHaveBeenCalledOnce();
    entries.find((entry) => /^About/.test(entry.label ?? ''))?.click?.();
    expect(help.about).toHaveBeenCalledOnce();
    expect(entries.some((entry) => entry.accelerator !== undefined)).toBe(false);
  });
});
