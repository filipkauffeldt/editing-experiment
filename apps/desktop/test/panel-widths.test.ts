// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CENTRE_MIN_WIDTH,
  PANEL_SIZE_SPECS,
  clampPanelSize,
  fitPanelSize,
  layoutPanelSizes,
  panelSizeLimits,
  sanitizePanelWidths,
} from '../src/shared/panel-widths';

describe('panel size clamping', () => {
  it('keeps a width inside its panel limits', () => {
    expect(clampPanelSize('library-sidebar', 10)).toBe(160);
    expect(clampPanelSize('library-sidebar', 300)).toBe(300);
    expect(clampPanelSize('library-sidebar', 5000)).toBe(520);
    expect(clampPanelSize('develop-panel', Number.NaN)).toBe(280);
  });

  it('keeps the film strip height inside its own limits', () => {
    expect(clampPanelSize('film-strip', 10)).toBe(72);
    expect(clampPanelSize('film-strip', 140)).toBe(140);
    expect(clampPanelSize('film-strip', 5000)).toBe(480);
    expect(clampPanelSize('film-strip', Number.NaN)).toBe(92);
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
        'film-strip': 40,
        'old-panel': 400,
      }),
    ).toEqual({ 'library-sidebar': 160, 'develop-metadata': 620, 'film-strip': 72 });
  });

  it('leaves the centre its minimum while the other panel keeps its width', () => {
    const other = PANEL_SIZE_SPECS['library-inspector'].defaultSize;
    const room = 1000 - CENTRE_MIN_WIDTH - other;
    expect(fitPanelSize('library-sidebar', 600, [other], { width: 1000 })).toBe(room);
    expect(fitPanelSize('library-sidebar', 100, [other], { width: 1000 })).toBe(160);
    // A window small enough to leave less than the centre minimum stops at the panel minimum.
    expect(fitPanelSize('library-sidebar', 600, [other], { width: 500 })).toBe(160);
  });

  it('stops the film strip at a third of the window', () => {
    expect(panelSizeLimits('film-strip', { height: 900 })).toEqual({ min: 72, max: 300 });
    expect(fitPanelSize('film-strip', 600, [], { height: 900 })).toBe(300);
    expect(fitPanelSize('film-strip', 10, [], { height: 900 })).toBe(72);
    // A short window keeps the strip's minimum rather than squeezing it below that.
    expect(fitPanelSize('film-strip', 600, [], { height: 180 })).toBe(72);
  });
});

describe('panel size layout', () => {
  it('uses the default widths until a preference exists', () => {
    expect(
      layoutPanelSizes(['library-sidebar', 'library-inspector'], undefined, { width: 1440 }),
    ).toEqual({
      'library-sidebar': 220,
      'library-inspector': 300,
    });
  });

  it('re-clamps for a smaller window without changing the stored preference', () => {
    const preferred = { 'library-sidebar': 520, 'library-inspector': 560 };
    const widths = layoutPanelSizes(['library-sidebar', 'library-inspector'], preferred, {
      width: 1000,
    });
    const available = 1000 - CENTRE_MIN_WIDTH;
    const shrink = (available - (160 + 240)) / (520 + 560 - (160 + 240));
    expect(widths['library-sidebar']).toBeCloseTo(160 + (520 - 160) * shrink, 5);
    expect(widths['library-inspector']).toBeCloseTo(240 + (560 - 240) * shrink, 5);
    expect(widths['library-sidebar']! + widths['library-inspector']! + 320).toBeCloseTo(1000, 5);
    expect(preferred).toEqual({ 'library-sidebar': 520, 'library-inspector': 560 });
  });

  it('falls back to the panel minimums when even those are too wide', () => {
    expect(
      layoutPanelSizes(['develop-metadata', 'develop-panel'], undefined, { width: 700 }),
    ).toEqual({
      'develop-metadata': 260,
      'develop-panel': 260,
    });
  });

  it('re-clamps the film strip to a third of a smaller window and keeps the preference', () => {
    const preferred = { 'film-strip': 300 };
    expect(layoutPanelSizes(['film-strip'], preferred, { height: 600 })).toEqual({
      'film-strip': 200,
    });
    expect(layoutPanelSizes(['film-strip'], preferred, { height: 1200 })).toEqual({
      'film-strip': 300,
    });
    expect(preferred).toEqual({ 'film-strip': 300 });
  });
});
