import { fireEvent, render, screen } from '@testing-library/react';
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
  await screen.findByRole('slider', { name: 'Exposure' });
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const exposureSlider = (): HTMLInputElement => {
  const slider = screen.getByRole('slider', { name: 'Exposure' });
  if (!(slider instanceof HTMLInputElement)) throw new Error('no exposure slider');
  return slider;
};

const key = (target: Element | Document | Window, init: KeyboardEventInit): void => {
  fireEvent.keyDown(target, init);
};

describe('slider focus after a pointer release', () => {
  it('blurs the range, commits its value and lets a rating shortcut apply', async () => {
    const store = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const slider = exposureSlider();

    slider.focus();
    fireEvent.change(slider, { target: { value: '1.5' } });
    expect(paramsForPhoto(store.getState(), photo).Exposure2012).toBe(1.5);

    fireEvent.pointerUp(slider);
    expect(document.activeElement).not.toBe(slider);
    expect(paramsForPhoto(store.getState(), photo).Exposure2012).toBe(1.5);

    key(window, { key: '4', code: 'Digit4' });
    expect(photoFlags(store.getState(), photo.id).rating).toBe(4);
  });

  it('also frees the range when the release happens outside the slider', async () => {
    const store = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const slider = exposureSlider();

    slider.focus();
    fireEvent.change(slider, { target: { value: '-0.75' } });
    fireEvent.pointerUp(document.body);

    expect(document.activeElement).not.toBe(slider);
    expect(paramsForPhoto(store.getState(), photo).Exposure2012).toBe(-0.75);
    key(window, { key: '2', code: 'Digit2' });
    expect(photoFlags(store.getState(), photo.id).rating).toBe(2);
  });

  it('keeps keyboard focus on a tabbed-to range and its shortcuts as they were', async () => {
    const store = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const slider = exposureSlider();
    const user = userEvent.setup();
    const before = photoFlags(store.getState(), photo.id).rating;

    screen.getByLabelText('Exposure value').focus();
    await user.tab();
    expect(document.activeElement).toBe(slider);

    key(slider, { key: 'ArrowRight', code: 'ArrowRight' });
    key(slider, { key: '4', code: 'Digit4' });

    expect(document.activeElement).toBe(slider);
    expect(photoFlags(store.getState(), photo.id).rating).toBe(before);
  });

  it('keeps a text field focused when the pointer is released elsewhere', async () => {
    const store = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const caption = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
    if (!caption) throw new Error('no caption field');
    const before = photoFlags(store.getState(), photo.id).rating;

    caption.focus();
    fireEvent.pointerUp(document.body);

    expect(document.activeElement).toBe(caption);
    key(caption, { key: '4', code: 'Digit4' });
    expect(photoFlags(store.getState(), photo.id).rating).toBe(before);
  });

  it('still resets a slider on double-click', async () => {
    const store = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const slider = exposureSlider();

    fireEvent.change(slider, { target: { value: '2' } });
    expect(paramsForPhoto(store.getState(), photo).Exposure2012).toBe(2);

    fireEvent.doubleClick(slider);
    expect(paramsForPhoto(store.getState(), photo).Exposure2012).toBeUndefined();
  });
});
