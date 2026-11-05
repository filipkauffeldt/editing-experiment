// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CENTRE_MIN_WIDTH,
  PANEL_WIDTH_SPECS,
  clampPanelWidth,
  fitPanelWidth,
  layoutPanelWidths,
  sanitizePanelWidths,
} from '../src/shared/panel-widths';

describe('panel width clamping', () => {
  it('keeps a width inside its panel limits', () => {
    expect(clampPanelWidth('library-sidebar', 10)).toBe(160);
    expect(clampPanelWidth('library-sidebar', 300)).toBe(300);
    expect(clampPanelWidth('library-sidebar', 5000)).toBe(520);
    expect(clampPanelWidth('develop-panel', Number.NaN)).toBe(280);
  });

  it('drops malformed saved values and clamps the rest', () => {
    expect(sanitizePanelWidths(undefined)).toBeUndefined();
    expect(sanitizePanelWidths('wide')).toBeUndefined();
    expect(sanitizePanelWidths({})).toBeUndefined();
    expect(
      sanitizePanelWidths({
        'library-sidebar': 80,
        'develop-metadata': 1000,
        'library-inspector': '300',
        'old-panel': 400,
      }),
    ).toEqual({ 'library-sidebar': 160, 'develop-metadata': 620 });
  });

  it('leaves the centre its minimum while the other panel keeps its width', () => {
    const other = PANEL_WIDTH_SPECS['library-inspector'].defaultWidth;
    const room = 1000 - CENTRE_MIN_WIDTH - other;
    expect(fitPanelWidth('library-sidebar', 600, [other], 1000)).toBe(room);
    expect(fitPanelWidth('library-sidebar', 100, [other], 1000)).toBe(160);
    // A window small enough to leave less than the centre minimum stops at the panel minimum.
    expect(fitPanelWidth('library-sidebar', 600, [other], 500)).toBe(160);
  });
});

describe('panel width layout', () => {
  it('uses the default widths until a preference exists', () => {
    expect(layoutPanelWidths(['library-sidebar', 'library-inspector'], undefined, 1440)).toEqual({
      'library-sidebar': 220,
      'library-inspector': 300,
    });
  });

  it('re-clamps for a smaller window without changing the stored preference', () => {
    const preferred = { 'library-sidebar': 520, 'library-inspector': 560 };
    const widths = layoutPanelWidths(['library-sidebar', 'library-inspector'], preferred, 1000);
    const available = 1000 - CENTRE_MIN_WIDTH;
    const shrink = (available - (160 + 240)) / (520 + 560 - (160 + 240));
    expect(widths['library-sidebar']).toBeCloseTo(160 + (520 - 160) * shrink, 5);
    expect(widths['library-inspector']).toBeCloseTo(240 + (560 - 240) * shrink, 5);
    expect(widths['library-sidebar']! + widths['library-inspector']! + 320).toBeCloseTo(1000, 5);
    expect(preferred).toEqual({ 'library-sidebar': 520, 'library-inspector': 560 });
  });

  it('falls back to the panel minimums when even those are too wide', () => {
    expect(layoutPanelWidths(['develop-metadata', 'develop-panel'], undefined, 700)).toEqual({
      'develop-metadata': 260,
      'develop-panel': 260,
    });
  });
});
