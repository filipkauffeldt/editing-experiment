import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as DevelopGl from '@ee/develop-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStoreProvider } from '../src/renderer/store-context';
import { PhotoCanvas } from '../src/renderer/components/PhotoCanvas';
import { activePhoto, createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const renderer = vi.hoisted(() => ({
  setImage: vi.fn(),
  setProfile: vi.fn(),
  render: vi.fn(),
  renderView: vi.fn(),
  renderSplit: vi.fn(),
  readHistogram: vi.fn(() => ({
    bins: 4,
    red: new Uint32Array(4),
    green: new Uint32Array(4),
    blue: new Uint32Array(4),
    luminance: new Uint32Array(4),
  })),
  renderToRGBA: vi.fn(() => new Uint8Array(4)),
  resolve: vi.fn(),
  contextLost: false,
  supportsNeighbourhood: true,
  softwareRendering: false,
  dispose: vi.fn(),
  /** The options the component created the renderer with. */
  options: undefined as { onNeighbourhoodUnavailable?: () => void } | undefined,
}));

vi.mock('@ee/develop-gl', async (importOriginal) => ({
  // The crop maths is real: the crop session in the store needs it.
  ...(await importOriginal<typeof DevelopGl>()),
  createDevelopRenderer: (_canvas: unknown, options?: typeof renderer.options) => {
    renderer.options = options;
    return renderer;
  },
  grainSeedFromId: () => 0,
}));

const pendingLinear = (): { resolve(response: Response): void; called: () => boolean } => {
  let resolve!: (response: Response) => void;
  let called = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes('/linear/')) return Promise.reject(new Error(`unexpected fetch ${url}`));
      called = true;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    }),
  );
  return { resolve: (response) => resolve(response), called: () => called };
};

const linearResponse = (): Response =>
  new Response(new ArrayBuffer(96), {
    status: 200,
    headers: {
      'x-ee-linear-image': JSON.stringify({
        width: 4,
        height: 3,
        sourceWidth: 4,
        sourceHeight: 3,
        sampleType: 'f16',
        asShotMultipliers: { r: 1, g: 1, b: 1 },
        cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      }),
    },
  });

/** The retouch overlay is bigger than the stage (it holds the hit margin); points are read off the stage. */
const stageOf = (overlay: Element): Element => {
  if (!overlay.parentElement) throw new Error('the overlay has no stage');
  return overlay.parentElement;
};

describe('PhotoCanvas preview', () => {
  let store: AppStore;
  let fake: FakeBridge;

  beforeEach(async () => {
    vi.stubGlobal('WebGL2RenderingContext', class {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === '2d' ? { clearRect: vi.fn(), putImageData: vi.fn() } : null) as never);
    fake = createFakeBridge({
      handlers: {
        'retouch:detectFaces': async () => {
          throw new Error('detector offline');
        },
      },
    });
    window.eeTransport = fake.transport;
    store = createAppStore(fake.bridge);
    await store.init();
  });

  afterEach(async () => {
    await store.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the cached preview exactly until the first linear frame renders', async () => {
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const pending = pendingLinear();

    render(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );

    const preview = await screen.findByTestId('preview-image');
    expect(preview.getAttribute('data-visible')).toBe('true');
    expect(preview.getAttribute('src')).toContain(`preview/${photo.id}`);
    expect(screen.getByTestId('develop-canvas').getAttribute('data-visible')).toBe('false');
    expect(pending.called()).toBe(true);

    fireEvent.load(preview);
    expect(screen.queryByText('Loading…')).toBeNull();

    await act(async () => {
      pending.resolve(linearResponse());
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId('develop-canvas').getAttribute('data-visible')).toBe('true'),
    );
    expect(preview.getAttribute('data-visible')).toBe('false');
  });

  it('tells the user once that a GPU without float targets skips the detail settings', async () => {
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    pendingLinear();
    render(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );
    await waitFor(() => expect(renderer.options?.onNeighbourhoodUnavailable).toBeDefined());
    const unavailable = renderer.options?.onNeighbourhoodUnavailable;
    act(() => {
      unavailable?.();
      unavailable?.();
    });
    const notices = store
      .getState()
      .toasts.filter((toast) => /float render targets/.test(toast.message));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('info');
  });

  it('shows a toast when face detection fails', async () => {
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const pending = pendingLinear();
    render(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );

    const preview = await screen.findByTestId('preview-image');
    fireEvent.load(preview);
    await act(async () => {
      pending.resolve(linearResponse());
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId('develop-canvas').getAttribute('data-visible')).toBe('true'),
    );
    act(() => {
      store.toggleRetouch();
      store.setRetouchTool('faces');
    });
    const overlay = await screen.findByTestId('retouch-overlay');
    vi.spyOn(stageOf(overlay), 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      top: 0,
      right: 400,
      bottom: 300,
      left: 0,
      toJSON: () => ({}),
    });
    Object.assign(overlay, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => false,
    });
    fireEvent.pointerDown(overlay, { clientX: 10, clientY: 200, pointerId: 1, button: 0 });
    fireEvent.pointerMove(overlay, { clientX: 390, clientY: 290, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 390, clientY: 290, pointerId: 1, button: 0 });

    await waitFor(() =>
      expect(
        store
          .getState()
          .toasts.some(
            (toast) =>
              toast.kind === 'error' &&
              toast.message.includes('Face detection failed: detector offline'),
          ),
      ).toBe(true),
    );
  });

  it('detects faces inside a lasso: searches its bounding box and keeps the faces centred in it', async () => {
    const regions: unknown[] = [];
    await store.dispose();
    fake = createFakeBridge({
      handlers: {
        'retouch:detectFaces': async (args) => {
          regions.push((args as { region?: unknown }).region);
          // One face inside the triangle drawn below, one in its bounding box but outside it.
          return [
            { box: { type: 'rect', x: 0.2, y: 0.5, w: 0.1, h: 0.1 }, score: 0.9 },
            { box: { type: 'rect', x: 0.6, y: 0.1, w: 0.1, h: 0.1 }, score: 0.9 },
          ];
        },
      },
    });
    window.eeTransport = fake.transport;
    store = createAppStore(fake.bridge);
    await store.init();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    pendingLinear();
    render(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );
    act(() => {
      store.toggleRetouch();
      store.setRetouchTool('faces');
    });
    const overlay = await screen.findByTestId('retouch-overlay');
    vi.spyOn(stageOf(overlay), 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      top: 0,
      right: 400,
      bottom: 300,
      left: 0,
      toJSON: () => ({}),
    });
    Object.assign(overlay, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => false,
    });
    // Lower-left triangle of the picture: (0.1, 0.1) (0.1, 0.9) (0.9, 0.9). Alt at the start of a
    // face search draws an outline instead of a rectangle.
    fireEvent.pointerDown(overlay, {
      clientX: 40,
      clientY: 30,
      pointerId: 1,
      button: 0,
      altKey: true,
    });
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 270, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 200, clientY: 270, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 360, clientY: 270, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 360, clientY: 270, pointerId: 1, button: 0 });

    await waitFor(() => expect(store.getState().retouch?.areas).toHaveLength(1));
    expect(store.getState().retouch?.areas[0]?.face?.box.x).toBeCloseTo(0.2);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    // The lasso itself is not a mosaic shape.
    expect(store.getState().retouch?.areas.every((area) => area.kind === 'face')).toBe(true);
  });

  describe('areas', () => {
    async function openOverlay(): Promise<HTMLElement> {
      const photo = activePhoto(store.getState());
      if (!photo) throw new Error('no selection');
      pendingLinear();
      render(
        <AppStoreProvider store={store}>
          <PhotoCanvas photo={photo} />
        </AppStoreProvider>,
      );
      act(() => store.toggleRetouch());
      const overlay = await screen.findByTestId('retouch-overlay');
      vi.spyOn(stageOf(overlay), 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        top: 0,
        right: 400,
        bottom: 300,
        left: 0,
        toJSON: () => ({}),
      });
      Object.assign(overlay, {
        setPointerCapture: vi.fn(),
        releasePointerCapture: vi.fn(),
        hasPointerCapture: () => false,
      });
      return overlay;
    }
    const drag = (
      overlay: HTMLElement,
      from: [number, number],
      to: [number, number],
      modifiers: { altKey?: boolean; ctrlKey?: boolean } = {},
    ): void => {
      fireEvent.pointerDown(overlay, {
        clientX: from[0],
        clientY: from[1],
        pointerId: 1,
        button: 0,
        ...modifiers,
      });
      fireEvent.pointerMove(overlay, { clientX: to[0], clientY: to[1], pointerId: 1 });
      fireEvent.pointerUp(overlay, { clientX: to[0], clientY: to[1], pointerId: 1, button: 0 });
    };

    it('opens on Faces and Add, whatever the last session used', async () => {
      const overlay = await openOverlay();
      expect(store.getState().retouch).toMatchObject({ tool: 'faces', mode: 'add' });
      expect(screen.getByRole('button', { name: 'Add' }).getAttribute('aria-pressed')).toBe('true');

      act(() => {
        store.setRetouchTool('lasso');
        store.setRetouchMode('subtract');
      });
      drag(overlay, [40, 40], [200, 200]);
      act(() => store.exitRetouch());
      act(() => store.toggleRetouch());
      expect(store.getState().retouch).toMatchObject({ tool: 'faces', mode: 'add' });
    });

    it('draws in Add or Subtract mode, and a click on an area switches it off and on', async () => {
      const overlay = await openOverlay();
      act(() => store.setRetouchTool('rect'));
      drag(overlay, [40, 30], [360, 270]);
      fireEvent.click(screen.getByRole('button', { name: 'Subtract' }));
      drag(overlay, [120, 90], [280, 210]);

      expect(store.getState().retouch?.areas.map((a) => [a.kind, a.mode, a.enabled])).toEqual([
        ['rect', 'add', true],
        ['rect', 'subtract', true],
      ]);
      expect(screen.getByTestId('drawn-count').textContent).toContain('2 of 2 areas on');

      // Click inside the hole: the topmost area there is the subtract area.
      drag(overlay, [200, 150], [200, 150]);
      expect(store.getState().retouch?.areas[1]?.enabled).toBe(false);
      expect(
        overlay.querySelector('[data-area-index="1"]')?.getAttribute('data-area-enabled'),
      ).toBe('false');
      expect(screen.getByTestId('drawn-count').textContent).toContain('1 of 2 areas on');
      // A click on the outer area only, outside the hole, switches that one.
      drag(overlay, [60, 40], [60, 40]);
      expect(store.getState().retouch?.areas.map((a) => a.enabled)).toEqual([false, false]);
      drag(overlay, [60, 40], [60, 40]);
      expect(store.getState().retouch?.areas[0]?.enabled).toBe(true);
      // Clicking does not draw anything.
      expect(store.getState().retouch?.areas).toHaveLength(2);
    });

    describe('starting outside the picture', () => {
      const shapeOf = (index = 0) => {
        const area = store.getState().retouch?.areas[index];
        return area?.shape;
      };

      it('clips a rectangle that starts in the margin to the picture edge', async () => {
        const overlay = await openOverlay();
        act(() => store.setRetouchTool('rect'));
        // From 10 px left of the picture and 15 px above it, into the picture.
        drag(overlay, [-10, -15], [200, 150]);
        expect(shapeOf()).toEqual({ type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5 });
        // Dragging out the other side from inside clips the same way.
        drag(overlay, [300, 200], [900, 700]);
        const clipped = shapeOf(1);
        if (clipped?.type !== 'rect') throw new Error('expected a rectangle');
        expect(clipped.x).toBeCloseTo(0.75, 9);
        expect(clipped.y).toBeCloseTo(2 / 3, 9);
        expect(clipped.x + clipped.w).toBe(1);
        expect(clipped.y + clipped.h).toBeCloseTo(1, 9);
      });

      it('clips a lasso to the picture and keeps every point within 0..1', async () => {
        const overlay = await openOverlay();
        act(() => store.setRetouchTool('lasso'));
        fireEvent.pointerDown(overlay, { clientX: -8, clientY: 100, pointerId: 1, button: 0 });
        for (const [x, y] of [
          [100, 20],
          [450, 120],
          [380, 330],
          [60, 250],
        ] as const) {
          fireEvent.pointerMove(overlay, { clientX: x, clientY: y, pointerId: 1 });
        }
        fireEvent.pointerUp(overlay, { clientX: -8, clientY: 160, pointerId: 1, button: 0 });
        const shape = shapeOf();
        if (shape?.type !== 'polygon') throw new Error('expected a lasso');
        for (const point of shape.points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(1);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(1);
        }
        expect(shape.points.some((point) => point.x === 0)).toBe(true);
        expect(shape.points.some((point) => point.x === 1)).toBe(true);
      });

      it('does nothing for a click in the margin, and a click on an area there does not toggle it', async () => {
        const overlay = await openOverlay();
        act(() => store.setRetouchTool('rect'));
        drag(overlay, [20, 20], [200, 150]);
        expect(store.getState().retouch?.areas[0]?.enabled).toBe(true);
        // The rectangle reaches (20, 20); a click 5 px outside the picture is not on it.
        drag(overlay, [-5, 20], [-5, 20]);
        drag(overlay, [20, -5], [20, -5]);
        expect(store.getState().retouch?.areas).toHaveLength(1);
        expect(store.getState().retouch?.areas[0]?.enabled).toBe(true);
      });

      it('adds nothing for a drag that stays outside the picture, and never runs detection', async () => {
        const overlay = await openOverlay();
        const calls = (): number =>
          fake.calls.filter((call) => call.channel === 'retouch:detectFaces').length;
        const before = calls();
        // Faces, rectangle: down the left margin, then along the top margin.
        drag(overlay, [-10, 20], [-10, 280]);
        drag(overlay, [20, -10], [380, -10]);
        // Faces with Alt (a lasso): around the outside of a corner.
        fireEvent.pointerDown(overlay, {
          clientX: -10,
          clientY: -10,
          pointerId: 1,
          button: 0,
          altKey: true,
        });
        for (const [x, y] of [
          [-10, -4],
          [-4, -10],
          [-10, -10],
        ] as const) {
          fireEvent.pointerMove(overlay, { clientX: x, clientY: y, pointerId: 1 });
        }
        fireEvent.pointerUp(overlay, { clientX: -10, clientY: -10, pointerId: 1, button: 0 });
        // Rectangle and Lasso tools.
        act(() => store.setRetouchTool('rect'));
        drag(overlay, [-10, 20], [-10, 280]);
        act(() => store.setRetouchTool('lasso'));
        drag(overlay, [-10, 20], [-10, 280]);
        expect(store.getState().retouch?.areas).toHaveLength(0);
        expect(calls()).toBe(before);
      });
    });

    it('Subtract with Detect faces removes the faces inside the dragged area and skips detection', async () => {
      const overlay = await openOverlay();
      const calls = fake.calls.filter((call) => call.channel === 'retouch:detectFaces').length;
      act(() => {
        store.addRetouchFaces([
          { box: { type: 'rect', x: 0.2, y: 0.2, w: 0.1, h: 0.1 } },
          { box: { type: 'rect', x: 0.7, y: 0.7, w: 0.1, h: 0.1 } },
        ]);
        store.setRetouchMode('subtract');
      });
      // Rectangle search area: (0.1, 0.1) to (0.5, 0.5) of the 400 x 300 surface.
      drag(overlay, [40, 30], [200, 150]);
      expect(store.getState().retouch?.areas.map((a) => a.face?.box.x)).toEqual([0.7]);

      // Lasso search area (Alt at the start of the drag): the same removal, outline-shaped.
      fireEvent.pointerDown(overlay, {
        clientX: 240,
        clientY: 180,
        pointerId: 1,
        button: 0,
        altKey: true,
      });
      for (const [x, y] of [
        [240, 270],
        [360, 270],
        [360, 180],
      ] as const) {
        fireEvent.pointerMove(overlay, { clientX: x, clientY: y, pointerId: 1 });
      }
      fireEvent.pointerUp(overlay, { clientX: 360, clientY: 180, pointerId: 1, button: 0 });
      expect(store.getState().retouch?.areas).toHaveLength(0);
      expect(fake.calls.filter((call) => call.channel === 'retouch:detectFaces')).toHaveLength(
        calls,
      );
    });

    it('Alt flips the mode for one drawing; AltGr (Ctrl+Alt) does not', async () => {
      const overlay = await openOverlay();
      act(() => store.setRetouchTool('rect'));
      drag(overlay, [40, 30], [360, 270], { altKey: true });
      drag(overlay, [60, 50], [100, 90], { altKey: true, ctrlKey: true });
      expect(store.getState().retouch?.areas.map((a) => a.mode)).toEqual(['subtract', 'add']);
      expect(store.getState().retouch?.mode).toBe('add');
    });

    it('draws straight after committing a typed block size with Enter', async () => {
      const overlay = await openOverlay();
      act(() => store.setRetouchTool('rect'));
      const field = screen.getByLabelText('Block size in px') as HTMLInputElement;
      field.focus();
      fireEvent.change(field, { target: { value: '48' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(document.activeElement).toBe(document.body);

      drag(overlay, [40, 30], [360, 270]);

      expect(store.getState().retouch?.areas).toHaveLength(1);
    });
  });

  it('Escape drops the shape being drawn and does not leave retouch', async () => {
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    pendingLinear();
    render(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );
    act(() => store.toggleRetouch());
    const overlay = await screen.findByTestId('retouch-overlay');
    vi.spyOn(stageOf(overlay), 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      top: 0,
      right: 400,
      bottom: 300,
      left: 0,
      toJSON: () => ({}),
    });
    Object.assign(overlay, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => true,
    });
    fireEvent.pointerDown(overlay, { clientX: 40, clientY: 40, pointerId: 1, button: 0 });
    fireEvent.pointerMove(overlay, { clientX: 200, clientY: 200, pointerId: 1 });

    // The app's own Escape handler listens on window; it must not see this one.
    const globalHandler = vi.fn();
    window.addEventListener('keydown', globalHandler);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(overlay, { clientX: 200, clientY: 200, pointerId: 1, button: 0 });
    window.removeEventListener('keydown', globalHandler);

    expect(globalHandler).not.toHaveBeenCalled();
    expect(store.getState().retouch).toBeDefined();
    expect(store.getState().retouch?.areas).toHaveLength(0);

    // With nothing mid-draw the key reaches the app's handler.
    window.addEventListener('keydown', globalHandler);
    fireEvent.keyDown(window, { key: 'Escape' });
    window.removeEventListener('keydown', globalHandler);
    expect(globalHandler).toHaveBeenCalledTimes(1);
  });

  it('busts the browser cache with the preview revision', async () => {
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    act(() => fake.emit('photos:updated', { ...photo, previewRevision: 3 }));
    pendingLinear();
    render(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );
    expect((await screen.findByTestId('preview-image')).getAttribute('src')).toBe(
      `app://preview/${photo.id}?v=3`,
    );
  });

  it('shows no cached image under a retouch or crop session: it is of the edited photo, not the uncropped one', async () => {
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    pendingLinear();
    const { rerender } = render(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );
    await screen.findByTestId('preview-image');

    act(() => store.toggleRetouch());
    expect(screen.queryByTestId('preview-image')).toBeNull();
    act(() => store.exitRetouch());
    expect(screen.getByTestId('preview-image')).toBeTruthy();

    act(() => store.toggleCrop());
    rerender(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );
    expect(screen.queryByTestId('preview-image')).toBeNull();
    act(() => store.cancelCrop());
    expect(screen.getByTestId('preview-image')).toBeTruthy();
  });

  it('falls back to the thumbnail when the preview is not cached', async () => {
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    pendingLinear();
    render(
      <AppStoreProvider store={store}>
        <PhotoCanvas photo={photo} />
      </AppStoreProvider>,
    );

    const preview = await screen.findByTestId('preview-image');
    fireEvent.error(preview);
    await waitFor(() =>
      expect(screen.getByTestId('preview-image').getAttribute('src')).toContain(
        `thumb/${photo.id}`,
      ),
    );
  });
});
