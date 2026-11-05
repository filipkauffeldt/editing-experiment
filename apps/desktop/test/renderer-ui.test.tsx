import { asPhotoId, type LensShotInfo } from '@ee/contracts';
import {
  cropAspect,
  multipliersFromTemperatureTint,
  resolveWhiteBalance,
  type WhiteBalanceCamera,
} from '@ee/develop-gl';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import {
  activePhoto,
  createAppStore,
  paramsForPhoto,
  photoFlags,
  type AppStore,
} from '../src/renderer/store';
import { temperatureToTrack, trackToTemperature } from '../src/renderer/temperature-scale';
import { zoomStore } from '../src/renderer/zoom-view';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(
  options: Parameters<typeof createFakeBridge>[0] = {},
): Promise<{ store: AppStore; fake: FakeBridge }> {
  const fake = createFakeBridge(options);
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

const enterRetouch = async (): Promise<void> => {
  fireEvent.keyDown(window, { key: 'r' });
  await screen.findByTestId('retouch-toolbar');
};

const typeInto = (field: HTMLInputElement, value: string): void => {
  field.focus();
  fireEvent.change(field, { target: { value } });
};

const commitWithEnter = (field: HTMLInputElement): void => {
  fireEvent.keyDown(field, { key: 'Enter' });
};

/** Blur through act, so the state a blur commits is visible to the next assertion. */
const blurField = (field: HTMLInputElement): void => {
  act(() => field.blur());
};

/** A text field swallows rating and pan keys; after it blurs the shortcut works again. */
async function expectNoGlobalKeys(store: AppStore, field: HTMLInputElement): Promise<void> {
  const photo = activePhoto(store.getState());
  if (!photo) throw new Error('no selection');
  const before = photoFlags(store.getState(), photo.id).rating;
  // A different key, so a rating that did fire is visible in the assertion.
  const ratingKey = before === 4 ? '3' : '4';
  const user = userEvent.setup();
  field.focus();
  await user.type(field, ratingKey);
  expect(zoomStore.get().panHeld).toBe(false);
  fireEvent.keyDown(field, { key: ' ', code: 'Space' });
  expect(photoFlags(store.getState(), photo.id).rating).toBe(before);
  expect(zoomStore.get().panHeld).toBe(false);

  blurField(field);
  fireEvent.keyDown(window, { key: ratingKey, code: `Digit${ratingKey}` });
  expect(photoFlags(store.getState(), photo.id).rating).toBe(Number(ratingKey));
}

describe('keyboard-first shell', () => {
  it('moves the selection, tags, rates and assigns a colour class', async () => {
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
    expect(photoFlags(store.getState(), first.id).rating).toBe(4);

    fireEvent.keyDown(window, { key: '4', code: 'Digit4', ctrlKey: true });
    expect(photoFlags(store.getState(), first.id).colorClass).toBe(4);
  });

  it('does not fire single-key shortcuts while typing, but Escape leaves the field', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const before = photoFlags(store.getState(), photo.id);

    const caption = captionField();
    caption.focus();
    await user.keyboard('t');
    await user.keyboard('7');
    fireEvent.keyDown(caption, { key: '5', code: 'Digit5' });
    fireEvent.keyDown(caption, { key: '2', code: 'Digit2', ctrlKey: true });
    expect(photoFlags(store.getState(), photo.id)).toEqual(before);
    expect(before).toMatchObject({ tagged: false, colorClass: 0 });

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
    expect(screen.getByTestId('export-dialog').textContent).toContain('Export 3 photos');

    fireEvent.click(screen.getByTestId('export-only'));
    await waitFor(() => {
      expect(fake.calls.some((call) => call.channel === 'export:start')).toBe(true);
    });
    const call = fake.calls.find((candidate) => candidate.channel === 'export:start');
    expect(call?.args[0]).toMatchObject({ send: [] });
    expect((call?.args[0] as { photoIds: string[] }).photoIds).toHaveLength(3);
    await waitFor(() => expect(store.getState().exportOpen).toBe(false));
  });

  it('clears and disables send targets for a develop-only preset', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('open-export'));
    await screen.findByTestId('export-dialog');
    const version = screen.getByDisplayValue('Top retouch version');
    fireEvent.change(version, { target: { value: 'develop' } });
    await waitFor(() =>
      expect(screen.getByDisplayValue('Develop only (export only)')).toBeTruthy(),
    );
    const outbox = screen.getByRole('checkbox', {
      name: /Sportfotografen outbox/,
    }) as HTMLInputElement;
    expect(outbox.checked).toBe(false);
    expect(outbox.disabled).toBe(true);
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

  it('leaves retouch with Done, keeping the drawn shape as a saved version', async () => {
    const { store, fake } = await renderApp();
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByTestId('retouch-toolbar');
    expect(screen.queryByTestId('discard-retouch')).toBeNull();
    act(() => store.addRetouchShape({ type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }));
    expect(screen.getByTestId('discard-retouch').textContent).toBe('Discard changes');

    fireEvent.click(screen.getByTestId('done-retouch'));

    await waitFor(() => expect(store.getState().retouch).toBeUndefined());
    expect(fake.calls.some((call) => call.channel === 'retouch:set')).toBe(true);
  });

  it('discards unsaved shapes only through the labelled button', async () => {
    const { store, fake } = await renderApp();
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByTestId('retouch-toolbar');
    act(() => store.addRetouchShape({ type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }));

    fireEvent.click(screen.getByTestId('discard-retouch'));

    expect(store.getState().retouch).toBeUndefined();
    expect(fake.calls.some((call) => call.channel === 'retouch:set')).toBe(false);
  });

  it('sets the block size in pixels of the full-resolution photo and stores a fraction', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo?.width || !photo.height) throw new Error('the mock photo has no size');
    fireEvent.keyDown(window, { key: 'r' });
    const slider = await screen.findByLabelText('Mosaic block size');
    const field = screen.getByLabelText('Block size in px') as HTMLInputElement;
    expect(field.value).toMatch(/^\d+$/);
    expect(screen.getByTestId('block-size-label').textContent).toBe('Block size');

    fireEvent.change(slider, { target: { value: '48' } });

    expect(field.value).toBe('48');
    expect(store.getState().retouch?.blockSizeRel).toBeCloseTo(
      48 / Math.max(photo.width, photo.height),
    );
  });

  it('commits a typed block size on Enter, not while the digits arrive', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo?.width || !photo.height) throw new Error('the mock photo has no size');
    const longEdge = Math.max(photo.width, photo.height);
    await enterRetouch();
    const field = screen.getByLabelText('Block size in px') as HTMLInputElement;
    const slider = screen.getByLabelText('Mosaic block size') as HTMLInputElement;
    const before = store.getState().retouch?.blockSizeRel;

    typeInto(field, '7');
    expect(store.getState().retouch?.blockSizeRel).toBe(before);
    expect(slider.value).not.toBe('7');
    fireEvent.change(field, { target: { value: '73' } });
    expect(store.getState().retouch?.blockSizeRel).toBe(before);
    expect(slider.value).not.toBe('73');

    commitWithEnter(field);

    expect(store.getState().retouch?.blockSizeRel).toBeCloseTo(73 / longEdge);
    expect(slider.value).toBe('73');
    expect(field.value).toBe('73');
    // Enter commits and leaves the field, but not Retouch.
    expect(document.activeElement).toBe(document.body);
    expect(store.getState().retouch).toBeDefined();
  });

  it('commits a typed block size on blur too', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo?.width || !photo.height) throw new Error('the mock photo has no size');
    await enterRetouch();
    const field = screen.getByLabelText('Block size in px') as HTMLInputElement;

    typeInto(field, '48');
    blurField(field);

    expect(store.getState().retouch?.blockSizeRel).toBeCloseTo(
      48 / Math.max(photo.width, photo.height),
    );
    expect(field.value).toBe('48');
  });

  it('clamps typed block sizes to the slider range and its safety floor', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo?.width || !photo.height) throw new Error('the mock photo has no size');
    const longEdge = Math.max(photo.width, photo.height);
    await enterRetouch();
    const field = screen.getByLabelText('Block size in px') as HTMLInputElement;
    const slider = screen.getByLabelText('Mosaic block size') as HTMLInputElement;

    typeInto(field, '9999');
    commitWithEnter(field);
    expect(store.getState().retouch?.blockSizeRel).toBeCloseTo(256 / longEdge);
    expect(slider.value).toBe('256');
    expect(field.value).toBe('256');

    typeInto(field, '1');
    commitWithEnter(field);
    expect(store.getState().retouch?.blockSizeRel).toBeCloseTo(8 / longEdge);
    expect(slider.value).toBe('8');
    expect(field.value).toBe('8');
  });

  it('restores the block size when the draft is cleared or invalid', async () => {
    const { store } = await renderApp();
    await enterRetouch();
    const field = screen.getByLabelText('Block size in px') as HTMLInputElement;
    const before = field.value;
    const beforeRel = store.getState().retouch?.blockSizeRel;

    typeInto(field, '');
    blurField(field);
    expect(field.value).toBe(before);
    expect(store.getState().retouch?.blockSizeRel).toBe(beforeRel);

    typeInto(field, '12px');
    commitWithEnter(field);
    expect(field.value).toBe(before);
    expect(store.getState().retouch?.blockSizeRel).toBe(beforeRel);
  });

  it('types the block size in percent while the photo size is unknown', async () => {
    const photos = mockPhotos();
    const unknownSize = { ...photos[0]!, width: undefined, height: undefined };
    const { store } = await renderApp({ photos: [unknownSize, ...photos.slice(1)] });
    await enterRetouch();
    const field = screen.getByLabelText('Block size in percent') as HTMLInputElement;
    const slider = screen.getByLabelText('Mosaic block size') as HTMLInputElement;

    typeInto(field, '2.5');
    commitWithEnter(field);
    expect(store.getState().retouch?.blockSizeRel).toBeCloseTo(0.025);
    expect(slider.value).toBe('0.025');
    expect(field.value).toBe('2.5');

    typeInto(field, '10');
    commitWithEnter(field);
    expect(store.getState().retouch?.blockSizeRel).toBeCloseTo(0.04);
    expect(field.value).toBe('4.0');
  });

  it('applies typed face padding in percent, clamps it and restores a bad draft', async () => {
    const { store } = await renderApp();
    await enterRetouch();
    const field = screen.getByLabelText('Face padding in percent') as HTMLInputElement;
    const slider = screen.getByLabelText('Face padding') as HTMLInputElement;

    typeInto(field, '35');
    commitWithEnter(field);
    expect(store.getState().retouch?.facePadding).toBeCloseTo(0.35);
    expect(slider.value).toBe('0.35');
    expect(field.value).toBe('35');

    typeInto(field, '80');
    commitWithEnter(field);
    expect(store.getState().retouch?.facePadding).toBeCloseTo(0.5);
    expect(field.value).toBe('50');

    typeInto(field, '-5');
    commitWithEnter(field);
    expect(store.getState().retouch?.facePadding).toBe(0);
    expect(field.value).toBe('0');

    typeInto(field, 'wide');
    commitWithEnter(field);
    expect(field.value).toBe('0');
    expect(store.getState().retouch?.facePadding).toBe(0);
  });

  it('disables the hidden Face padding field but keeps its room', async () => {
    const { store } = await renderApp();
    await enterRetouch();
    const field = screen.getByLabelText('Face padding in percent') as HTMLInputElement;
    const slider = screen.getByLabelText('Face padding') as HTMLInputElement;
    expect(field.disabled).toBe(false);
    expect(field.tabIndex).toBe(0);

    act(() => store.setRetouchTool('rect'));

    expect(field.disabled).toBe(true);
    expect(field.tabIndex).toBe(-1);
    expect(slider.disabled).toBe(true);
    expect(field.closest('[aria-hidden="true"]')).toBeTruthy();
    // Still mounted, so the control keeps the toolbar's height.
    expect(screen.getByText('Face padding')).toBeTruthy();
  });

  it('does not rate or pan from the typed retouch fields', async () => {
    const { store } = await renderApp();
    await enterRetouch();
    await expectNoGlobalKeys(store, screen.getByLabelText('Block size in px') as HTMLInputElement);
    await expectNoGlobalKeys(
      store,
      screen.getByLabelText('Face padding in percent') as HTMLInputElement,
    );
  });

  it('leaves a typed field with Escape without leaving retouch', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo?.width || !photo.height) throw new Error('the mock photo has no size');
    await enterRetouch();
    const field = screen.getByLabelText('Block size in px') as HTMLInputElement;

    typeInto(field, '48');
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(document.activeElement).toBe(document.body);
    expect(store.getState().retouch).toBeDefined();
    expect(store.getState().retouch?.blockSizeRel).toBeCloseTo(
      48 / Math.max(photo.width, photo.height),
    );
  });

  it('blurs a typed field when the photo is clicked', async () => {
    await renderApp();
    await enterRetouch();
    const field = screen.getByLabelText('Block size in px') as HTMLInputElement;
    field.focus();
    expect(document.activeElement).toBe(field);

    fireEvent.pointerDown(screen.getByTestId('mosaic-canvas'), { pointerId: 1, button: 0 });

    expect(document.activeElement).toBe(document.body);
  });

  it('leaves with Escape even when a slider has focus', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'r' });
    const slider = await screen.findByLabelText('Mosaic block size');
    slider.focus();

    fireEvent.keyDown(slider, { key: 'Escape' });

    await waitFor(() => expect(store.getState().retouch).toBeUndefined());
  });

  it('leaves with the Develop tab and with the footer toggle', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByTestId('retouch-toolbar');

    fireEvent.click(screen.getByRole('tab', { name: 'Develop' }));
    await waitFor(() => expect(store.getState().retouch).toBeUndefined());

    fireEvent.click(screen.getByTestId('toggle-retouch'));
    expect(store.getState().retouch).toBeDefined();
    fireEvent.click(screen.getByTestId('toggle-retouch'));
    await waitFor(() => expect(store.getState().retouch).toBeUndefined());
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

  it('commits a typed angle with a comma or a dot and stays in crop', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    const field = screen.getByLabelText('Angle in degrees') as HTMLInputElement;
    const slider = screen.getByLabelText('Straighten angle') as HTMLInputElement;

    typeInto(field, '3,5');
    expect(store.getState().crop?.crop.angle).toBe(0);
    commitWithEnter(field);
    expect(store.getState().crop?.crop.angle).toBeCloseTo(3.5);
    expect(slider.value).toBe('3.5');
    expect(field.value).toBe('3.5');
    expect(document.activeElement).toBe(document.body);
    expect(store.getState().crop).toBeDefined();

    typeInto(field, '-12.3');
    commitWithEnter(field);
    expect(store.getState().crop?.crop.angle).toBeCloseTo(-12.3);
    expect(slider.value).toBe('-12.3');
  });

  it('clamps a typed angle to the slider limits and restores a bad draft', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    const field = screen.getByLabelText('Angle in degrees') as HTMLInputElement;
    const slider = screen.getByLabelText('Straighten angle') as HTMLInputElement;

    typeInto(field, '90');
    commitWithEnter(field);
    expect(store.getState().crop?.crop.angle).toBe(45);
    expect(slider.value).toBe('45');
    expect(field.value).toBe('45.0');

    typeInto(field, '-90');
    commitWithEnter(field);
    expect(store.getState().crop?.crop.angle).toBe(-45);

    typeInto(field, '');
    blurField(field);
    expect(field.value).toBe('-45.0');
    expect(store.getState().crop?.crop.angle).toBe(-45);

    typeInto(field, 'north');
    blurField(field);
    expect(field.value).toBe('-45.0');
    expect(store.getState().crop?.crop.angle).toBe(-45);
  });

  it('does not rate or pan from the typed angle', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    await expectNoGlobalKeys(store, screen.getByLabelText('Angle in degrees') as HTMLInputElement);
  });

  it('leaves the typed angle with Escape without leaving crop', async () => {
    const { store } = await renderApp();
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    const field = screen.getByLabelText('Angle in degrees') as HTMLInputElement;

    typeInto(field, '8');
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(document.activeElement).toBe(document.body);
    expect(store.getState().crop).toBeDefined();
    expect(store.getState().crop?.crop.angle).toBeCloseTo(8);
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

  describe('dragging inside the frame', () => {
    const openCrop = async () => {
      const { store } = await renderApp();
      fireEvent.keyDown(window, { key: 'c' });
      await waitFor(() => expect(store.getState().crop).toBeDefined());
      const overlay = await screen.findByTestId('crop-overlay');
      stubCapture(overlay);
      return { store, overlay };
    };
    /** A point on the frame as a fraction of its size; jsdom has no layout, so these are client coordinates. */
    const at = (overlay: HTMLElement, x: number, y: number) => {
      const frame = frameOf(overlay);
      return { clientX: frame.left + frame.width * x, clientY: frame.top + frame.height * y };
    };
    const drag = (
      overlay: HTMLElement,
      from: { clientX: number; clientY: number },
      to: { clientX: number; clientY: number },
    ) => {
      fireEvent.pointerDown(overlay, { ...from, button: 0, pointerId: 1 });
      fireEvent.pointerMove(overlay, {
        clientX: (from.clientX + to.clientX) / 2,
        clientY: (from.clientY + to.clientY) / 2,
        pointerId: 1,
      });
      fireEvent.pointerMove(overlay, { ...to, pointerId: 1 });
      fireEvent.pointerUp(overlay, { ...to, pointerId: 1 });
    };

    it('draws a frame from the press to the pointer on an uncropped photo', async () => {
      const { store, overlay } = await openCrop();
      fireEvent.click(screen.getByText('Free'));
      const whole = frameOf(overlay);
      const from = at(overlay, 0.25, 0.2);
      const to = at(overlay, 0.7, 0.8);
      drag(overlay, from, to);

      const drawn = frameOf(overlay);
      expect(drawn.left).toBeCloseTo(from.clientX, 3);
      expect(drawn.top).toBeCloseTo(from.clientY, 3);
      expect(drawn.left + drawn.width).toBeCloseTo(to.clientX, 3);
      expect(drawn.top + drawn.height).toBeCloseTo(to.clientY, 3);
      expect(drawn.width).toBeLessThan(whole.width);
      expect(store.getState().crop?.tool).toBe('crop');
      expect(store.getState().crop?.gesture).toBeUndefined();

      // The frame is cropped now: a further drag inside pans the image as it always did.
      // The frame stays put on screen and the image follows the pointer, so the crop goes
      // the other way: left of the pointer's move and below it.
      const cropped = store.getState().crop!.crop;
      const grab = at(overlay, 0.5, 0.5);
      drag(overlay, grab, { clientX: grab.clientX - 10, clientY: grab.clientY + 6 });
      const panned = frameOf(overlay);
      expect(panned.left).toBeCloseTo(drawn.left, 6);
      expect(panned.top).toBeCloseTo(drawn.top, 6);
      expect(panned.width).toBeCloseTo(drawn.width, 6);
      expect(panned.height).toBeCloseTo(drawn.height, 6);
      const after = store.getState().crop!.crop;
      expect(after.left).toBeGreaterThan(cropped.left);
      expect(after.top).toBeLessThan(cropped.top);
      expect(after.right - after.left).toBeCloseTo(cropped.right - cropped.left, 9);
      expect(after.bottom - after.top).toBeCloseTo(cropped.bottom - cropped.top, 9);
    });

    it('draws with the locked aspect and collapses the frame from the first drag past the minimum', async () => {
      const { store, overlay } = await openCrop();
      const whole = frameOf(overlay);
      const ratio = whole.width / whole.height;
      const from = at(overlay, 0.3, 0.3);
      fireEvent.pointerDown(overlay, { ...from, button: 0, pointerId: 1 });
      fireEvent.pointerMove(overlay, {
        clientX: from.clientX + 120,
        clientY: from.clientY + 10,
        pointerId: 1,
      });
      // Already a smaller frame with its corner under the press, in the photo's own ratio.
      const drawn = frameOf(overlay);
      expect(drawn.left).toBeCloseTo(from.clientX, 3);
      expect(drawn.top).toBeCloseTo(from.clientY, 3);
      expect(drawn.width).toBeCloseTo(120, 3);
      expect(drawn.width / drawn.height).toBeCloseTo(ratio, 3);
      expect(store.getState().crop?.gesture).toBe('draw');
      fireEvent.pointerUp(overlay, {
        clientX: from.clientX + 120,
        clientY: from.clientY + 10,
        pointerId: 1,
      });
    });

    it('changes nothing on a click or a drag below the minimum, and a double-click applies', async () => {
      const { store, overlay } = await openCrop();
      const before = store.getState().crop?.crop;
      const centre = at(overlay, 0.5, 0.5);
      drag(overlay, centre, centre);
      expect(store.getState().crop?.crop).toEqual(before);
      drag(overlay, centre, { clientX: centre.clientX + 0.2, clientY: centre.clientY });
      expect(store.getState().crop?.crop).toEqual(before);
      expect(store.getState().crop?.tool).toBe('crop');

      for (let i = 0; i < 2; i++) {
        fireEvent.pointerDown(overlay, { ...centre, button: 0, pointerId: 1 });
        fireEvent.pointerUp(overlay, { ...centre, pointerId: 1 });
      }
      fireEvent.doubleClick(overlay, centre);
      expect(store.getState().crop).toBeUndefined();
    });

    it('pans a frame cropped on one axis along that axis only, the image following the pointer', async () => {
      const { store, overlay } = await openCrop();
      // 1:1 on a photo that is not square leaves one axis whole.
      fireEvent.click(screen.getByText('1:1'));
      const before = frameOf(overlay);
      const cropBefore = store.getState().crop!.crop;
      const wholeWidth = cropBefore.right - cropBefore.left === 1;
      const grab = at(overlay, 0.5, 0.5);
      fireEvent.pointerDown(overlay, { ...grab, button: 0, pointerId: 1 });
      expect(store.getState().crop?.gesture).toBe('pan');
      fireEvent.pointerUp(overlay, { ...grab, pointerId: 1 });
      drag(overlay, grab, { clientX: grab.clientX + 8, clientY: grab.clientY + 8 });
      // The frame does not move; the crop slides against the pointer on the axis with room.
      expect(frameOf(overlay)).toEqual(before);
      const after = store.getState().crop!.crop;
      if (wholeWidth) {
        expect(after.left).toBe(cropBefore.left);
        expect(after.right).toBe(cropBefore.right);
        expect(after.top).toBeLessThan(cropBefore.top);
        expect(after.bottom - after.top).toBeCloseTo(cropBefore.bottom - cropBefore.top, 9);
      } else {
        expect(after.top).toBe(cropBefore.top);
        expect(after.bottom).toBe(cropBefore.bottom);
        expect(after.left).toBeLessThan(cropBefore.left);
        expect(after.right - after.left).toBeCloseTo(cropBefore.right - cropBefore.left, 9);
      }
    });

    it('pans a straightened frame instead of drawing over it', async () => {
      const { store, overlay } = await openCrop();
      store.setCropAngle(4);
      await waitFor(() => expect(overlay.getAttribute('data-angle')).toBe('4'));
      const before = frameOf(overlay);
      const sizeBefore = store.getState().crop!.crop;
      const grab = at(overlay, 0.5, 0.5);
      fireEvent.pointerDown(overlay, { ...grab, button: 0, pointerId: 1 });
      expect(store.getState().crop?.gesture).toBe('pan');
      fireEvent.pointerUp(overlay, { ...grab, pointerId: 1 });
      drag(overlay, grab, { clientX: grab.clientX + 60, clientY: grab.clientY + 40 });
      expect(frameOf(overlay)).toEqual(before);
      const after = store.getState().crop!.crop;
      expect(after.angle).toBe(4);
      expect(after.right - after.left).toBeCloseTo(sizeBefore.right - sizeBefore.left, 9);
    });

    it('shows a crosshair where a drag would draw, a hand where it would move, and follows the crop', async () => {
      const { store, overlay } = await openCrop();
      fireEvent.pointerMove(overlay, { ...at(overlay, 0.5, 0.5), pointerId: 1 });
      expect(overlay.style.cursor).toBe('crosshair');
      fireEvent.click(screen.getByText('1:1'));
      // The pointer has not moved, but the frame changed under it.
      expect(overlay.style.cursor).toBe('grab');
      fireEvent.click(screen.getByTitle(/Reset the crop/));
      expect(overlay.style.cursor).toBe('crosshair');
      expect(store.getState().crop?.crop).toMatchObject({ left: 0, top: 0, right: 1, bottom: 1 });
    });

    it('draws again after Reset', async () => {
      const { store, overlay } = await openCrop();
      fireEvent.click(screen.getByText('1:1'));
      fireEvent.click(screen.getByTitle(/Reset the crop/));
      const whole = frameOf(overlay);
      drag(overlay, at(overlay, 0.2, 0.2), at(overlay, 0.6, 0.6));
      expect(frameOf(overlay).width).toBeLessThan(whole.width);
      expect(store.getState().crop?.tool).toBe('crop');
    });
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
  const cameraMatrix = [0.821, -0.2534, -0.0683, -0.5355, 1.3338, 0.2212, -0.1143, 0.193, 0.6464];
  const asShotCamera = (): WhiteBalanceCamera => ({
    xyzToCamera: cameraMatrix,
    asShotMultipliers: multipliersFromTemperatureTint(cameraMatrix, 5400, 8),
  });

  it('shows the as-shot temperature and tint without marking the photo edited', async () => {
    const { store, fake } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const camera = asShotCamera();
    const expected = resolveWhiteBalance(camera, {});
    act(() => store.setPhotoWhiteBalance(photo.id, camera));

    const temperature = screen.getByLabelText('Temperature value') as HTMLInputElement;
    const tint = screen.getByLabelText('Tint value') as HTMLInputElement;
    await waitFor(() => expect(temperature.value).toBe(String(Math.round(expected.temperature))));
    expect(tint.value).toBe(String(Math.round(expected.tint)));
    expect(screen.getByText('As Shot')).toBeTruthy();

    const track = screen.getByLabelText('Temperature') as HTMLInputElement;
    expect(Number(track.value)).toBe(temperatureToTrack(Math.round(expected.temperature)));
    expect(
      store.getState().photos.find((candidate) => candidate.id === photo.id)?.status.edited,
    ).toBe(false);
    expect(fake.calls.filter((call) => call.channel === 'develop:setParams')).toHaveLength(0);
  });

  it('starts the first drag from the as-shot temperature', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    act(() => store.setPhotoWhiteBalance(photo.id, asShotCamera()));

    const track = screen.getByLabelText('Temperature') as HTMLInputElement;
    await waitFor(() =>
      expect(Number(track.value)).toBe(
        temperatureToTrack(Math.round(resolveWhiteBalance(asShotCamera(), {}).temperature)),
      ),
    );
    const next = Number(track.value) + 10;
    fireEvent.change(track, { target: { value: String(next) } });
    await waitFor(() =>
      expect(paramsForPhoto(store.getState(), activePhoto(store.getState())).Temperature).toBe(
        trackToTemperature(next),
      ),
    );
  });

  it('shows Lightroom’s relative 0/0 scale for a file without raw multipliers', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    act(() =>
      store.setPhotoWhiteBalance(photo.id, {
        asShotMultipliers: { r: 1, g: 1, b: 1 },
        xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      }),
    );

    const temperature = screen.getByLabelText('Temperature value') as HTMLInputElement;
    const tint = screen.getByLabelText('Tint value') as HTMLInputElement;
    await waitFor(() => expect(temperature.value).toBe('0'));
    expect(tint.value).toBe('0');
    expect(temperature.type).toBe('text');
    const track = screen.getByLabelText('Temperature') as HTMLInputElement;
    expect(track.min).toBe('-100');
    expect(track.max).toBe('100');
    expect(track.value).toBe('0');
  });
});

describe('raw defaults in the develop panel', () => {
  it('shows Lightroom’s raw sharpening as 40, and 0 once the user turns it off', async () => {
    await renderApp({
      handlers: {
        'develop:getDefaults': async () => ({ Sharpness: 40, ColorNoiseReduction: 25 }),
      },
    });
    // "Amount" also labels the vignette and grain sliders, so look inside the Sharpening group.
    const group = (title: string): HTMLElement => {
      const section = screen.getByRole('heading', { name: title }).parentElement;
      if (!section) throw new Error(`no ${title} group`);
      return section;
    };
    const amount = (): HTMLInputElement =>
      within(group('Sharpening')).getByLabelText<HTMLInputElement>('Amount value');
    await waitFor(() => expect(amount().value).toBe('40'));
    expect(
      within(group('Noise reduction')).getByLabelText<HTMLInputElement>('Color value').value,
    ).toBe('25');

    fireEvent.change(amount(), { target: { value: '0' } });
    await waitFor(() => expect(amount().value).toBe('0'));
    // Double-click on the slider goes back to the default, not to 0.
    fireEvent.doubleClick(within(group('Sharpening')).getByLabelText('Amount'));
    await waitFor(() => expect(amount().value).toBe('40'));
  });
});

describe('lens corrections in the develop panel', () => {
  const nikonZ6: LensShotInfo = {
    cameraModel: 'NIKON Z 6',
    lensModel: 'NIKKOR Z 24-70mm f/4 S',
    focalLength: 24,
    focalLength35: 24,
    fNumber: 4,
  };

  it('says there is no lens data for a photo without any', async () => {
    await renderApp();
    const panel = await screen.findByTestId('lens-corrections');
    expect(within(panel).getByTestId('lens-profile-note').textContent).toBe(
      'No lens data for this photo.',
    );
    expect(within(panel).getByLabelText<HTMLSelectElement>('Lens profile').disabled).toBe(true);
  });

  it('shows the matched Lensfun profile, lets the user switch it on and pick another', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    act(() => store.setPhotoLens(photo.id, nikonZ6, { width: 6048, height: 4032 }));
    const panel = await screen.findByTestId('lens-corrections');
    const select = within(panel).getByLabelText<HTMLSelectElement>('Lens profile');
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.selectedOptions[0]?.textContent).toBe('Automatic');
    expect(within(panel).getByTestId('lens-profile-note').textContent).toBe(
      'Nikkor Z 24-70mm f/4 S (Lensfun): corrects distortion, vignetting, chromatic aberration.',
    );
    // Off until asked for: a lens the camera does not require.
    const enable = within(panel).getByLabelText<HTMLInputElement>('Enable profile corrections');
    expect(enable.checked).toBe(false);

    fireEvent.click(enable);
    await waitFor(() => expect(enable.checked).toBe(true));
    expect(paramsForPhoto(store.getState(), photo).LensProfileEnable).toBe(true);

    // Override with another lens from the list; back to automatic with the first entry.
    const other = [...select.options].find((o) => o.textContent?.includes('24-120mm f/4 S'));
    if (!other) throw new Error('no 24-120mm in the list');
    fireEvent.change(select, { target: { value: other.value } });
    await waitFor(() =>
      expect(paramsForPhoto(store.getState(), photo).LensProfileChoice).toBe(other.value),
    );
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() =>
      expect(paramsForPhoto(store.getState(), photo).LensProfileChoice).toBeUndefined(),
    );
  });

  it('keeps the shortcuts working after a switch is clicked', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    act(() => store.setPhotoLens(photo.id, nikonZ6, { width: 6048, height: 4032 }));
    const panel = await screen.findByTestId('lens-corrections');
    const removeCa = within(panel).getByLabelText<HTMLInputElement>('Remove chromatic aberration');
    removeCa.focus();
    fireEvent.click(removeCa);
    const user = userEvent.setup();
    await user.keyboard('t');
    await waitFor(() => expect(photoFlags(store.getState(), photo.id).tagged).toBe(true));
  });

  it('keeps a lens the camera requires on until the user turns it off', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    act(() =>
      store.setPhotoLens(
        photo.id,
        {
          ...nikonZ6,
          builtin: {
            source: 'Nikon built-in',
            required: true,
            centre: { x: 0, y: 0 },
            unit: 1,
            distortion: [1],
          },
        },
        { width: 6048, height: 4032 },
      ),
    );
    const panel = await screen.findByTestId('lens-corrections');
    const enable = within(panel).getByLabelText<HTMLInputElement>('Enable profile corrections');
    await waitFor(() => expect(enable.checked).toBe(true));
    expect(within(panel).getByTestId('lens-profile-note').textContent).toMatch(/camera requires/);
    fireEvent.click(enable);
    await waitFor(() => expect(enable.checked).toBe(false));
    expect(paramsForPhoto(store.getState(), photo).LensProfileEnable).toBe(false);
  });
});
