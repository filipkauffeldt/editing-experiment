import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStoreProvider } from '../src/renderer/store-context';
import { PhotoCanvas } from '../src/renderer/components/PhotoCanvas';
import { activePhoto, createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const renderer = vi.hoisted(() => ({
  setImage: vi.fn(),
  render: vi.fn(),
  renderToRGBA: vi.fn(() => new Uint8Array(4)),
  resolve: vi.fn(),
  contextLost: false,
  dispose: vi.fn(),
}));

vi.mock('@ee/develop-gl', () => ({
  createDevelopRenderer: () => renderer,
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

  beforeEach(async () => {
    vi.stubGlobal('WebGL2RenderingContext', class {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === '2d' ? { clearRect: vi.fn(), putImageData: vi.fn() } : null) as never);
    const fake = createFakeBridge();
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
