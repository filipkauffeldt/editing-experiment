import { asPhotoId } from '@ee/contracts';
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
      expect(fake.calls.some((call) => call.channel === 'export:photo')).toBe(true);
    });
    await waitFor(() => {
      expect(activePhoto(store.getState())?.id).not.toBe(first?.id);
    });
  });
});

describe('film strip', () => {
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
