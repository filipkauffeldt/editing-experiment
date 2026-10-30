import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { activePhoto, createAppStore, paramsForPhoto, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(): Promise<AppStore> {
  const fake = createFakeBridge();
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  await waitFor(() => expect(store.getState().selectedId).toBeDefined());
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const params = (store: AppStore) => paramsForPhoto(store.getState(), activePhoto(store.getState()));

function mockBox(element: HTMLElement, size = 255): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: size,
    height: size,
    top: 0,
    right: size,
    bottom: size,
    left: 0,
    toJSON: () => ({}),
  });
}

const graph = (): HTMLElement => screen.getByTestId('tone-curve-graph');

describe('tone curve editor', () => {
  it('adds, moves and deletes points that stay sorted and inside 0..255', async () => {
    const store = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Point (RGB)' }));
    mockBox(graph());

    fireEvent.pointerDown(graph(), { clientX: 128, clientY: 115, button: 0, pointerId: 1 });
    fireEvent.pointerUp(graph(), { clientX: 128, clientY: 115, pointerId: 1 });
    await waitFor(() =>
      expect(params(store).ToneCurvePV2012).toEqual([
        [0, 0],
        [128, 140],
        [255, 255],
      ]),
    );

    fireEvent.pointerDown(graph(), { clientX: 128, clientY: 115, button: 0, pointerId: 1 });
    fireEvent.pointerMove(graph(), { clientX: 200, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(graph(), { clientX: 200, clientY: 80, pointerId: 1 });
    const moved = params(store).ToneCurvePV2012 ?? [];
    expect(moved[1]).toEqual([200, 175]);
    expect(moved.map(([x]) => x)).toEqual([0, 200, 255]);

    // Dragging a middle point out of the box removes it.
    fireEvent.pointerDown(graph(), { clientX: 200, clientY: 80, button: 0, pointerId: 2 });
    fireEvent.pointerMove(graph(), { clientX: 300, clientY: 80, pointerId: 2 });
    fireEvent.pointerUp(graph(), { clientX: 300, clientY: 80, pointerId: 2 });
    await waitFor(() =>
      expect(params(store).ToneCurvePV2012).toEqual([
        [0, 0],
        [255, 255],
      ]),
    );
  });

  it('never deletes an endpoint, by dragging it out or double-clicking it', async () => {
    const store = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Point (RGB)' }));
    mockBox(graph());

    fireEvent.pointerDown(graph(), { clientX: 128, clientY: 115, button: 0, pointerId: 1 });
    fireEvent.pointerUp(graph(), { clientX: 128, clientY: 115, pointerId: 1 });
    expect(params(store).ToneCurvePV2012).toHaveLength(3);

    fireEvent.pointerDown(graph(), { clientX: 0, clientY: 255, button: 0, pointerId: 2 });
    fireEvent.pointerMove(graph(), { clientX: -20, clientY: 300, pointerId: 2 });
    fireEvent.pointerUp(graph(), { clientX: -20, clientY: 300, pointerId: 2 });
    expect(params(store).ToneCurvePV2012).toHaveLength(3);

    fireEvent.doubleClick(screen.getByTestId('tone-curve-point-0'));
    expect(params(store).ToneCurvePV2012).toHaveLength(3);
    fireEvent.doubleClick(screen.getByTestId('tone-curve-point-2'));
    expect(params(store).ToneCurvePV2012).toHaveLength(3);
  });

  it('deletes a point with a double-click and resets the channel on empty space', async () => {
    const store = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Point (RGB)' }));
    mockBox(graph());

    fireEvent.pointerDown(graph(), { clientX: 64, clientY: 128, button: 0, pointerId: 1 });
    fireEvent.pointerUp(graph(), { clientX: 64, clientY: 128, pointerId: 1 });
    expect(params(store).ToneCurvePV2012).toHaveLength(3);

    fireEvent.doubleClick(screen.getByTestId('tone-curve-point-1'));
    expect(params(store).ToneCurvePV2012).toEqual([
      [0, 0],
      [255, 255],
    ]);

    fireEvent.doubleClick(graph(), { clientX: 150, clientY: 100 });
    expect(params(store).ToneCurvePV2012).toBeUndefined();
  });

  it('edits the curve of the selected channel only', async () => {
    const store = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Red' }));
    mockBox(graph());

    fireEvent.pointerDown(graph(), { clientX: 64, clientY: 128, button: 0, pointerId: 1 });
    fireEvent.pointerUp(graph(), { clientX: 64, clientY: 128, pointerId: 1 });
    await waitFor(() =>
      expect(params(store).ToneCurvePV2012Red).toEqual([
        [0, 0],
        [64, 127],
        [255, 255],
      ]),
    );
    expect(params(store).ToneCurvePV2012).toBeUndefined();
    expect(params(store).ToneCurvePV2012Green).toBeUndefined();
    expect(params(store).ToneCurvePV2012Blue).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(params(store).ToneCurvePV2012Red).toBeUndefined();
  });

  it('shows the input and output values in mono on hover', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Point (RGB)' }));
    mockBox(graph());

    fireEvent.pointerMove(graph(), { clientX: 128, clientY: 255 - 128, pointerId: 1 });
    expect(screen.getByTestId('tone-curve-readout').textContent).toBe('128 → 128');
  });

  it('lifts a parametric region by dragging up inside it and moves a split handle', async () => {
    const store = await renderApp();
    mockBox(graph());

    fireEvent.pointerDown(graph(), { clientX: 20, clientY: 127, button: 0, pointerId: 1 });
    fireEvent.pointerMove(graph(), { clientX: 20, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(graph(), { clientX: 20, clientY: 60, pointerId: 1 });
    expect(params(store).ParametricShadows).toBeGreaterThan(0);
    expect(params(store).ParametricHighlights ?? 0).toBe(0);

    const split = screen.getByTestId('tone-curve-split-shadow');
    split.focus();
    fireEvent.keyDown(split, { key: 'ArrowRight' });
    expect(params(store).ParametricShadowSplit).toBe(26);
    fireEvent.keyDown(split, { key: 'ArrowLeft' });
    expect(params(store).ParametricShadowSplit).toBeUndefined();
  });

  it('parks and restores the curves with the section switch', async () => {
    const store = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Point (RGB)' }));
    mockBox(graph());
    fireEvent.pointerDown(graph(), { clientX: 64, clientY: 128, button: 0, pointerId: 1 });
    fireEvent.pointerUp(graph(), { clientX: 64, clientY: 128, pointerId: 1 });
    expect(params(store).ToneCurvePV2012).toHaveLength(3);

    const toggle = screen.getByRole('switch', { name: 'Tone Curve on or off' });
    fireEvent.click(toggle);
    expect(params(store).ToneCurvePV2012).toBeUndefined();
    fireEvent.click(toggle);
    expect(params(store).ToneCurvePV2012).toHaveLength(3);
  });
});

describe('color grading wheels', () => {
  it('sets hue from the angle and saturation from the radius', async () => {
    const store = await renderApp();
    const wheel = screen.getByTestId('grading-wheel-shadows');
    mockBox(wheel, 96);

    fireEvent.pointerDown(wheel, { clientX: 48, clientY: 28, button: 0, pointerId: 1 });
    fireEvent.pointerUp(wheel, { clientX: 48, clientY: 28, pointerId: 1 });
    expect(params(store).ColorGradeShadowHue).toBe(90);
    expect(params(store).ColorGradeShadowSat).toBe(47);

    fireEvent.doubleClick(screen.getByTestId('grading-puck-shadows'));
    expect(params(store).ColorGradeShadowHue).toBeUndefined();
    expect(params(store).ColorGradeShadowSat).toBeUndefined();
  });

  it('keeps hue during a Shift-drag and saturation during a Ctrl-drag', async () => {
    const store = await renderApp();
    const wheel = screen.getByTestId('grading-wheel-shadows');
    mockBox(wheel, 96);

    fireEvent.pointerDown(wheel, { clientX: 48, clientY: 28, button: 0, pointerId: 1 });
    fireEvent.pointerUp(wheel, { clientX: 48, clientY: 28, pointerId: 1 });
    expect(params(store).ColorGradeShadowHue).toBe(90);

    fireEvent.pointerDown(wheel, { clientX: 48, clientY: 28, button: 0, pointerId: 2 });
    fireEvent.pointerMove(wheel, {
      clientX: 8,
      clientY: 48,
      pointerId: 2,
      shiftKey: true,
    });
    fireEvent.pointerUp(wheel, { clientX: 8, clientY: 48, pointerId: 2 });
    expect(params(store).ColorGradeShadowHue).toBe(90);
    expect(params(store).ColorGradeShadowSat).toBe(93);

    fireEvent.pointerDown(wheel, { clientX: 48, clientY: 8, button: 0, pointerId: 3 });
    fireEvent.pointerMove(wheel, {
      clientX: 88,
      clientY: 48,
      pointerId: 3,
      ctrlKey: true,
    });
    fireEvent.pointerUp(wheel, { clientX: 88, clientY: 48, pointerId: 3 });
    expect(params(store).ColorGradeShadowHue ?? 0).toBe(0);
    expect(params(store).ColorGradeShadowSat).toBe(93);
  });

  it('treats AltGr as a normal drag, not as Ctrl', async () => {
    const store = await renderApp();
    const wheel = screen.getByTestId('grading-wheel-shadows');
    mockBox(wheel, 96);

    fireEvent.pointerDown(wheel, {
      clientX: 48,
      clientY: 78,
      button: 0,
      pointerId: 1,
      ctrlKey: true,
      altKey: true,
    });
    fireEvent.pointerUp(wheel, { clientX: 48, clientY: 78, pointerId: 1 });
    expect(params(store).ColorGradeShadowHue).toBe(270);
    expect(params(store).ColorGradeShadowSat).toBe(70);
  });

  it('switches between the 3-way and single-region views and writes luminance', async () => {
    const store = await renderApp();
    expect(screen.getByTestId('grading-shadows')).toBeDefined();
    expect(screen.getByTestId('grading-midtones')).toBeDefined();
    expect(screen.getByTestId('grading-highlights')).toBeDefined();
    expect(screen.queryByTestId('grading-global')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Global' }));
    expect(screen.getByTestId('grading-global')).toBeDefined();
    expect(screen.queryByTestId('grading-shadows')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '3-way' }));
    const luminance = screen.getByLabelText('Shadows luminance');
    fireEvent.change(luminance, { target: { value: '30' } });
    expect(params(store).ColorGradeShadowLum).toBe(30);

    const wheel = screen.getByTestId('grading-wheel-shadows');
    wheel.focus();
    fireEvent.keyDown(wheel, { key: 'ArrowRight' });
    expect(params(store).ColorGradeShadowHue).toBe(1);
  });
});
