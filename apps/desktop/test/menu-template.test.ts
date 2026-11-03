import { describe, expect, it } from 'vitest';
import { applicationMenuTemplate } from '../src/main/menu-template';

type Entry = { role?: string; accelerator?: string; submenu?: Entry[] };

const flatten = (entries: Entry[]): Entry[] =>
  entries.flatMap((entry) => [entry, ...flatten(entry.submenu ?? [])]);

describe('application menu', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    it(`has no page zoom entries on ${platform}, which would take Ctrl/Cmd + - and 0`, () => {
      const entries = flatten(applicationMenuTemplate(platform) as Entry[]);
      const roles = entries.map((entry) => entry.role);
      expect(roles).not.toContain('zoomIn');
      expect(roles).not.toContain('zoomOut');
      expect(roles).not.toContain('resetZoom');
      expect(roles).not.toContain('viewMenu');
      expect(entries.some((entry) => /zoom/i.test(entry.accelerator ?? ''))).toBe(false);
    });

    it(`keeps the edit, reload and DevTools roles on ${platform}`, () => {
      const roles = flatten(applicationMenuTemplate(platform) as Entry[]).map(
        (entry) => entry.role,
      );
      expect(roles).toContain('editMenu');
      expect(roles).toContain('reload');
      expect(roles).toContain('toggleDevTools');
    });
  }
});
