import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as DevelopGl from '@ee/develop-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStoreProvider } from '../src/renderer/store-context';
import { PhotoCanvas } from '../src/renderer/components/PhotoCanvas';
import { activePhoto, createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const renderer = vi.hoisted(() => ({
  setImage: vi.fn(),
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
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
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
