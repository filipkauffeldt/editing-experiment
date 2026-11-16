import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { activePhoto, createAppStore, paramsForPhoto, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(): Promise<{ store: AppStore }> {
  const fake = createFakeBridge();
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  return { store };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const exposure = (store: AppStore): number | undefined =>
  paramsForPhoto(store.getState(), activePhoto(store.getState())).Exposure2012;

function change(store: AppStore, value: number): void {
  act(() => store.setSlider('Exposure2012', value));
}

/** A drag that set 0.1, then a second change 0.2: ending the gesture makes two undo steps. */
function expectTwoSteps(store: AppStore): void {
  expect(exposure(store)).toBe(0.2);
  act(() => {
    expect(store.undoDevelop()).toBe(true);
  });
  expect(exposure(store)).toBe(0.1);
  act(() => {
    expect(store.undoDevelop()).toBe(true);
  });
  expect(exposure(store)).toBeUndefined();
}

describe('develop gestures end on every path', () => {
  it('ends on pointer up', async () => {
    const { store } = await renderApp();
    fireEvent.pointerDown(window, { button: 0, pointerId: 1 });
    change(store, 0.1);
    fireEvent.pointerUp(window, { pointerId: 1 });
    change(store, 0.2);
    expectTwoSteps(store);
  });

  it('ends on pointer cancel', async () => {
    const { store } = await renderApp();
    fireEvent.pointerDown(window, { button: 0, pointerId: 2 });
    change(store, 0.1);
    fireEvent.pointerCancel(window, { pointerId: 2 });
    change(store, 0.2);
    expectTwoSteps(store);
  });

  it('ends when pointer capture is lost', async () => {
    const { store } = await renderApp();
    fireEvent.pointerDown(window, { button: 0, pointerId: 1 });
    change(store, 0.1);
    fireEvent(window, new Event('lostpointercapture'));
    change(store, 0.2);
    expectTwoSteps(store);
  });

  it('ends when the window loses focus', async () => {
    const { store } = await renderApp();
    fireEvent.pointerDown(window, { button: 0, pointerId: 1 });
    change(store, 0.1);
    fireEvent(window, new Event('blur'));
    change(store, 0.2);
    expectTwoSteps(store);
  });

  it('ends on Escape during a drag', async () => {
    const { store } = await renderApp();
    fireEvent.pointerDown(window, { button: 0, pointerId: 1 });
    change(store, 0.1);
    fireEvent.keyDown(window, { key: 'Escape' });
    change(store, 0.2);
    expectTwoSteps(store);
  });

  it('ends when the photo changes, for a drag and a typed value', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    const second = store.getState().photos.find((candidate) => candidate.id !== photo?.id);
    if (!photo || !second) throw new Error('no photos');

    act(() => store.beginDevelopGesture());
    change(store, 0.1);
    act(() => store.select(second.id));
    change(store, 0.2);
    expect(exposure(store)).toBe(0.2);
    act(() => {
      expect(store.undoDevelop()).toBe(true);
    });
    expect(exposure(store)).toBeUndefined();
    act(() => store.select(photo.id));
    act(() => {
      expect(store.undoDevelop()).toBe(true);
    });
    expect(exposure(store)).toBeUndefined();

    act(() => store.beginDevelopTypedEdit());
    change(store, 0.3);
    act(() => store.select(second.id));
    change(store, 0.4);
    act(() => {
      expect(store.undoDevelop()).toBe(true);
    });
    act(() => store.select(photo.id));
    act(() => {
      expect(store.undoDevelop()).toBe(true);
    });
    expect(exposure(store)).toBeUndefined();
  });
});
