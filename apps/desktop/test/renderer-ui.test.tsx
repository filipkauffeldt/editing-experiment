import { asPhotoId } from '@ee/contracts';
import { cropAspect } from '@ee/develop-gl';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { activePhoto, createAppStore, photoFlags, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(): Promise<{ store: AppStore; fake: FakeBridge }> {
  const fake = createFakeBridge();
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  return { store, fake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const thumbnail = (fileName: string): HTMLElement => {
  const button = document.querySelector<HTMLElement>(`button[title^="${fileName}"]`);
  if (!button) throw new Error(`no thumbnail for ${fileName}`);
  return button;
};

const captionField = (): HTMLTextAreaElement => {
  const field = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
  if (!field) throw new Error('no caption field');
  return field;
};

describe('keyboard-first shell', () => {
  it('moves the selection, tags and assigns a colour class', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    expect(activePhoto(store.getState())?.fileName).toBe('_DSC8330.NEF');

    await user.keyboard('{ArrowRight}');
    expect(activePhoto(store.getState())?.fileName).toBe('_DSC8331.NEF');

    await user.keyboard('{ArrowLeft}');
    const first = activePhoto(store.getState());
    if (!first) throw new Error('no selection');

    await user.keyboard('t');
    expect(photoFlags(store.getState(), first.id).tagged).toBe(true);

    await user.keyboard('4');
    expect(photoFlags(store.getState(), first.id).colorClass).toBe(4);
  });

  it('does not fire single-key shortcuts while typing, but Escape leaves the field', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');

    const caption = captionField();
    caption.focus();
    await user.keyboard('t');
    await user.keyboard('7');
    expect(photoFlags(store.getState(), photo.id)).toEqual({ tagged: false, colorClass: 0 });

    fireEvent.keyDown(caption, { key: 'Escape' });
    expect(document.activeElement).toBe(document.body);
  });

  it('ignores single-key shortcuts with modifiers or during IME composition', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const before = activePhoto(store.getState())?.id;

    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    fireEvent.keyDown(window, { key: 't', metaKey: true });
    fireEvent.keyDown(window, { key: 't', altKey: true });
    fireEvent.keyDown(window, { key: 't', isComposing: true });
    fireEvent.keyDown(window, { key: 't', keyCode: 229 });
    fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true });

    expect(photoFlags(store.getState(), photo.id).tagged).toBe(false);
    expect(activePhoto(store.getState())?.id).toBe(before);
  });

  it('focuses the caption with Ctrl+I and finishes with Ctrl+Enter', async () => {
    const { store, fake } = await renderApp();
    const first = activePhoto(store.getState());

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    expect(document.activeElement).toBe(captionField());

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(fake.calls.some((call) => call.channel === 'export:start')).toBe(true);
    });
    await waitFor(() => {
      expect(activePhoto(store.getState())?.id).not.toBe(first?.id);
    });
  });
});

describe('film strip', () => {
  it('selects a range and exports it from the dialog without uploading', async () => {
    const { store, fake } = await renderApp();
    fireEvent.click(thumbnail('_DSC8330.NEF'));
    fireEvent.click(thumbnail('_DSC8332.NEF'), { shiftKey: true });
    expect(store.getState().selection).toHaveLength(3);

    fireEvent.keyDown(window, { key: 'e', ctrlKey: true, shiftKey: true });
    await screen.findByTestId('export-dialog');
    expect(screen.getByTestId('export-dialog').textContent).toContain('3 photos selected');

    fireEvent.click(screen.getByTestId('export-only'));
    await waitFor(() => {
      expect(fake.calls.some((call) => call.channel === 'export:start')).toBe(true);
    });
    const call = fake.calls.find((candidate) => candidate.channel === 'export:start');
    expect(call?.args[0]).toMatchObject({ send: [] });
    expect((call?.args[0] as { photoIds: string[] }).photoIds).toHaveLength(3);
    await waitFor(() => expect(store.getState().exportOpen).toBe(false));
  });

  it('shows edit, retouch, metadata and upload badges', async () => {
    await renderApp();

    expect(within(thumbnail('_DSC8332.NEF')).getByTitle('Retouch version')).toBeTruthy();
    expect(within(thumbnail('_DSC8332.NEF')).getByTitle('Uploading')).toBeTruthy();
    expect(within(thumbnail('_DSC8332.NEF')).queryByTitle('Edited')).toBeNull();
    expect(within(thumbnail('_DSC8331.NEF')).getByTitle('Queued for upload')).toBeTruthy();
    expect(within(thumbnail('_DSC8333.NEF')).getByTitle('Upload failed')).toBeTruthy();
    expect(
      within(thumbnail('_DSC8334.NEF')).getByTitle('Metadata differs from template'),
    ).toBeTruthy();
    expect(within(thumbnail('_DSC8330.NEF')).getByTitle('Uploaded')).toBeTruthy();
  });
});

describe('metadata panel', () => {
  it('expands codes on Ctrl+Space and shows unknown variables inline', async () => {
    const { store, fake } = await renderApp();
    const photoId = asPhotoId('mock-01');
    await waitFor(() => expect(store.getState().metadata[photoId]).toBeDefined());

    const caption = captionField();
    fireEvent.change(caption, {
      target: { value: '=t1= at {location} {photographer}' },
    });
    fireEvent.keyDown(caption, { key: ' ', ctrlKey: true });

    await waitFor(() => {
      expect(caption.value).toBe('Manchester City at Etihad Stadium {photographer}');
    });
    expect(screen.getByText('Unknown codes:')).toBeTruthy();
    expect(screen.getByText('{photographer}')).toBeTruthy();

    await waitFor(() => {
      expect(fake.calls.some((call) => call.channel === 'metadata:write')).toBe(true);
    });
  });

  it('highlights fields that differ from the template', async () => {
    const { store } = await renderApp();
    store.select(asPhotoId('mock-05'));

    await waitFor(() => {
      expect(screen.getByTestId('metadata-panel').textContent).toContain('Liverpool');
    });
    const panel = screen.getByTestId('metadata-panel');
    expect(within(panel).getByText('differs')).toBeTruthy();
    expect(within(panel).getByTitle(/Template: Manchester/)).toBeTruthy();
  });
});

describe('retouch version', () => {
  it('shows the committed retouch version indicator outside retouch mode', async () => {
    const { store } = await renderApp();
    store.select(asPhotoId('mock-03'));
    await waitFor(() => expect(screen.getByTestId('retouch-version-indicator')).toBeTruthy());
    expect(screen.queryByTestId('retouch-toolbar')).toBeNull();
  });
});

describe('crop mode', () => {
  it('opens with C, edits aspect and angle, and applies through develop:setParams', async () => {
    const { store, fake } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');

    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    expect(await screen.findByTestId('crop-overlay')).toBeTruthy();
    const toolbar = screen.getByTestId('crop-toolbar');

    fireEvent.click(within(toolbar).getByText('3:2'));
    const landscape = store.getState().crop;
    if (!landscape) throw new Error('no crop session');
    expect(
      cropAspect(landscape.crop, {
        width: photo.width ?? 0,
        height: photo.height ?? 0,
      }),
    ).toBeCloseTo(3 / 2, 6);

    fireEvent.change(screen.getByLabelText('Straighten angle'), { target: { value: '3' } });
    expect(store.getState().crop?.crop.angle).toBeCloseTo(3, 9);

    fireEvent.keyDown(window, { key: 'x' });
    expect(store.getState().crop?.flipped).toBe(true);

    fireEvent.click(screen.getByTestId('apply-crop'));
    await waitFor(() => expect(store.getState().crop).toBeUndefined());
    await waitFor(() => {
      expect(
        fake.calls.some(
          (call) =>
            call.channel === 'develop:setParams' &&
            (call.args[0] as { params: { crop?: { angle: number } } }).params.crop?.angle === 3,
        ),
      ).toBe(true);
    });
  });

  it('resets the angle by double-clicking the slider', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    const slider = screen.getByLabelText('Straighten angle');
    fireEvent.change(slider, { target: { value: '7.5' } });
    expect(store.getState().crop?.crop.angle).toBeCloseTo(7.5, 9);
    fireEvent.doubleClick(slider);
    expect(store.getState().crop?.crop.angle).toBe(0);
  });

  it('switches tools and overlays with R, A and O, and resets with Ctrl+Alt+R', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());

    fireEvent.keyDown(window, { key: 'r' });
    expect(store.getState().crop?.tool).toBe('draw');
    expect(store.getState().retouch).toBeUndefined();
    fireEvent.keyDown(window, { key: 'r' });
    expect(store.getState().crop?.tool).toBe('crop');
    fireEvent.keyDown(window, { key: 'a' });
    expect(store.getState().crop?.tool).toBe('straighten');

    fireEvent.keyDown(window, { key: 'o' });
    expect(store.getState().crop?.overlay).toBe('grid');
    expect(screen.getByTestId('crop-overlay').getAttribute('data-guide')).toBe('grid');

    store.setCropAngle(12);
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true });
    expect(store.getState().crop?.crop.angle).toBe(0);
    expect(store.getState().crop?.tool).toBe('crop');
    // Still in crop mode: reset does not leave it.
    expect(store.getState().crop).toBeDefined();
  });

  it('applies on Enter and on a double-click inside the frame', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    store.setCropAngle(4);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(store.getState().crop).toBeUndefined();

    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    const overlay = await screen.findByTestId('crop-overlay');
    const [left = 0, top = 0, width = 0, height = 0] = (overlay.getAttribute('data-frame') ?? '')
      .split(',')
      .map(Number);
    // jsdom has no layout: the overlay's box is at 0,0, so frame coordinates are client coordinates.
    fireEvent.doubleClick(overlay, { clientX: left + width / 2, clientY: top + height / 2 });
    expect(store.getState().crop).toBeUndefined();
  });

  /** jsdom has no pointer capture; the overlay only needs it to exist. */
  const stubCapture = (element: HTMLElement): void => {
    Object.assign(element, {
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => false,
    });
  };

  const frameOf = (overlay: HTMLElement) => {
    const [left = 0, top = 0, width = 0, height = 0] = (overlay.getAttribute('data-frame') ?? '')
      .split(',')
      .map(Number);
    return { left, top, width, height };
  };

  it('does not commit on a double-click that follows a pan', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    // A frame smaller than the image, so the pan has somewhere to go.
    fireEvent.click(screen.getByText('1:1'));
    const overlay = await screen.findByTestId('crop-overlay');
    stubCapture(overlay);
    const frame = frameOf(overlay);
    const centre = { clientX: frame.left + frame.width / 2, clientY: frame.top + frame.height / 2 };

    fireEvent.pointerDown(overlay, { ...centre, button: 0, pointerId: 1 });
    fireEvent.pointerMove(overlay, {
      clientX: centre.clientX + 40,
      clientY: centre.clientY,
      pointerId: 1,
    });
    fireEvent.pointerUp(overlay, {
      clientX: centre.clientX + 40,
      clientY: centre.clientY,
      pointerId: 1,
    });
    fireEvent.doubleClick(overlay, { clientX: centre.clientX + 40, clientY: centre.clientY });
    expect(store.getState().crop).toBeDefined();

    // Two clean clicks do commit.
    const moved = frameOf(overlay);
    const again = { clientX: moved.left + moved.width / 2, clientY: moved.top + moved.height / 2 };
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(overlay, { ...again, button: 0, pointerId: 1 });
      fireEvent.pointerUp(overlay, { ...again, pointerId: 1 });
    }
    fireEvent.doubleClick(overlay, again);
    expect(store.getState().crop).toBeUndefined();
  });

  it('abandons a drag on pointer cancel and keeps the frame tool', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    fireEvent.click(screen.getByText('Free'));
    fireEvent.keyDown(window, { key: 'r' });
    expect(store.getState().crop?.tool).toBe('draw');
    const overlay = await screen.findByTestId('crop-overlay');
    stubCapture(overlay);
    const frame = frameOf(overlay);
    const before = store.getState().crop?.crop;

    fireEvent.pointerDown(overlay, {
      clientX: frame.left + 40,
      clientY: frame.top + 40,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(overlay, {
      clientX: frame.left + 200,
      clientY: frame.top + 160,
      pointerId: 1,
    });
    expect(store.getState().crop?.crop).not.toEqual(before);
    fireEvent.pointerCancel(overlay, { pointerId: 1 });
    expect(store.getState().crop?.crop).toEqual(before);
    expect(store.getState().crop?.tool).toBe('draw');
    expect(store.getState().crop?.gesture).toBeUndefined();
  });

  it('ignores A, O, X and R while an input has focus', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    fireEvent.click(screen.getByText('3:2'));
    const before = store.getState().crop;
    if (!before) throw new Error('no crop session');

    for (const field of [
      screen.getByLabelText('Straighten angle'),
      document.createElement('textarea'),
    ]) {
      if (!field.isConnected) document.body.appendChild(field);
      field.focus();
      for (const key of ['a', 'A', 'o', 'O', 'x', 'X', 'r', 'R']) {
        fireEvent.keyDown(field, { key });
      }
      const after = store.getState().crop;
      expect(after?.tool).toBe(before.tool);
      expect(after?.overlay).toBe(before.overlay);
      expect(after?.flipped).toBe(before.flipped);
      expect(after?.crop).toEqual(before.crop);
      expect(store.getState().retouch).toBeUndefined();
    }
    // Out of the field the same keys act.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: 'o' });
    expect(store.getState().crop?.overlay).not.toBe(before.overlay);
  });

  it('cancels with Escape without saving a crop', async () => {
    const { store, fake } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    fireEvent.change(screen.getByLabelText('Straighten angle'), { target: { value: '5' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(store.getState().crop).toBeUndefined());
    expect(
      fake.calls.some(
        (call) =>
          call.channel === 'develop:setParams' &&
          (call.args[0] as { params: { crop?: unknown } }).params.crop !== undefined,
      ),
    ).toBe(false);
  });
});

describe('develop panel', () => {
  it('shows As shot for unset white balance', async () => {
    await renderApp();
    const temperature = screen.getByLabelText('Temperature value') as HTMLInputElement;
    await waitFor(() => expect(temperature.placeholder).toBe('As shot'));
    expect(temperature.value).toBe('');

    const track = screen.getByLabelText('Temperature') as HTMLInputElement;
    expect(Number(track.value)).toBeGreaterThan(500);
    expect(Number(track.value)).toBeLessThan(750);
  });
});
