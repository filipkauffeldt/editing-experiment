import {
  multipliersFromTemperatureTint,
  resolveWhiteBalance,
  type WhiteBalanceCamera,
} from '@ee/develop-gl';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import {
  AS_SHOT_TEMPERATURE,
  relativeToTemperature,
  temperatureToTrack,
} from '../src/renderer/temperature-scale';
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
  await screen.findByRole('slider', { name: 'Exposure' });
  return { store, fake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const field = (label: string): HTMLInputElement => {
  const input = screen.getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
  return input;
};

const params = (store: AppStore) => paramsForPhoto(store.getState(), activePhoto(store.getState()));

const cameraMatrix = [0.821, -0.2534, -0.0683, -0.5355, 1.3338, 0.2212, -0.1143, 0.193, 0.6464];

const asShotCamera = (): WhiteBalanceCamera => ({
  xyzToCamera: cameraMatrix,
  asShotMultipliers: multipliersFromTemperatureTint(cameraMatrix, 5400, 8),
});

const asShotTemperature = (): number =>
  Math.round(resolveWhiteBalance(asShotCamera(), {}).temperature);

const setRawWhiteBalance = (store: AppStore): void => {
  const photo = activePhoto(store.getState());
  if (!photo) throw new Error('no selection');
  act(() => store.setPhotoWhiteBalance(photo.id, asShotCamera()));
};

describe('typed slider values', () => {
  it('types 5500 on Temperature without applying the clamped intermediate values', async () => {
    const { store } = await renderApp();
    setRawWhiteBalance(store);
    const user = userEvent.setup();
    const temperature = field('Temperature value');
    await waitFor(() => expect(temperature.value).toBe(String(asShotTemperature())));
    expect(temperature.inputMode).toBe('numeric');

    await user.tripleClick(temperature);
    await user.keyboard('5');
    expect(temperature.value).toBe('5');
    expect(params(store).Temperature).toBeUndefined();

    await user.keyboard('5');
    expect(temperature.value).toBe('55');
    expect(params(store).Temperature).toBeUndefined();

    await user.keyboard('0');
    expect(temperature.value).toBe('550');
    expect(params(store).Temperature).toBeUndefined();

    await user.keyboard('0');
    expect(temperature.value).toBe('5500');
    expect(params(store).Temperature).toBe(5500);
    // The track follows the live value.
    expect(Number(field('Temperature').value)).toBe(temperatureToTrack(5500));

    await user.keyboard('{Enter}');
    expect(document.activeElement).not.toBe(temperature);
    expect(temperature.value).toBe('5500');
  });

  it('keeps a cleared Temperature field empty until blur, then goes back to As Shot', async () => {
    const { store } = await renderApp();
    setRawWhiteBalance(store);
    act(() => store.setSlider('Temperature', 4000));
    const user = userEvent.setup();
    const temperature = field('Temperature value');
    await waitFor(() => expect(temperature.value).toBe('4000'));

    await user.tripleClick(temperature);
    await user.keyboard('{Backspace}');
    expect(temperature.value).toBe('');
    expect(params(store).Temperature).toBe(4000);

    await user.tab();
    await waitFor(() => expect(temperature.value).toBe(String(asShotTemperature())));
    expect(params(store).Temperature).toBeUndefined();
    expect(screen.getByText('As Shot')).toBeTruthy();
  });

  it('waits for a complete negative comma value on Exposure', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const exposure = field('Exposure value');

    await user.tripleClick(exposure);
    await user.keyboard('-');
    expect(exposure.value).toBe('-');
    expect(params(store).Exposure2012).toBeUndefined();

    await user.keyboard('1,5');
    expect(exposure.value).toBe('-1,5');
    expect(params(store).Exposure2012).toBe(-1.5);

    await user.keyboard('{Enter}');
    expect(exposure.value).toBe('-1.5');
    expect(params(store).Exposure2012).toBe(-1.5);

    // A dot is a decimal separator too.
    await user.tripleClick(exposure);
    await user.keyboard('1.5');
    expect(params(store).Exposure2012).toBe(1.5);
    expect(exposure.inputMode).toBe('decimal');
  });

  it('clamps an out-of-range value at Enter and rounds to the step', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const temperature = field('Temperature value');

    await user.tripleClick(temperature);
    await user.keyboard('60000');
    expect(temperature.value).toBe('60000');
    // 6000 was the last in-range draft and is what the photo shows until commit.
    expect(params(store).Temperature).toBe(6000);

    await user.keyboard('{Enter}');
    expect(temperature.value).toBe('50000');
    expect(params(store).Temperature).toBe(50000);
  });

  it('restores with Escape without leaving retouch', async () => {
    const { store } = await renderApp();
    act(() => store.setSlider('Temperature', 4000));
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByTestId('retouch-toolbar');
    // Retouch opens with the develop panel hidden; Tab shows it again.
    fireEvent.keyDown(window, { key: 'Tab' });
    const user = userEvent.setup();
    const temperature = field('Temperature value');
    await waitFor(() => expect(temperature.value).toBe('4000'));

    await user.tripleClick(temperature);
    await user.keyboard('5500');
    expect(params(store).Temperature).toBe(5500);

    await user.keyboard('{Escape}');
    expect(store.getState().retouch).toBeDefined();
    expect(params(store).Temperature).toBe(4000);
    expect(temperature.value).toBe('4000');
    expect(document.activeElement).not.toBe(temperature);
  });

  it('steps with the arrow keys and applies at once', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const exposure = field('Exposure value');

    await user.click(exposure);
    await user.keyboard('{ArrowUp}');
    expect(exposure.value).toBe('0.01');
    expect(params(store).Exposure2012).toBe(0.01);

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(exposure.value).toBe('-0.01');
    expect(params(store).Exposure2012).toBe(-0.01);
  });

  it('discards the draft on a photo change and still saves the last live value', async () => {
    const { store, fake } = await renderApp();
    const first = activePhoto(store.getState());
    const second = store.getState().photos.find((photo) => photo.id !== first?.id);
    if (!first || !second) throw new Error('need two photos');
    const user = userEvent.setup();
    const temperature = field('Temperature value');

    await user.tripleClick(temperature);
    await user.keyboard('5500');
    await user.keyboard('{ArrowUp}');
    expect(paramsForPhoto(store.getState(), first).Temperature).toBe(5501);

    act(() => store.select(second.id));
    await waitFor(() => expect(activePhoto(store.getState())?.id).toBe(second.id));
    // The new photo's field shows its own value, not the draft for the old one.
    expect(field('Temperature value').value).toBe(String(AS_SHOT_TEMPERATURE));
    expect(params(store).Temperature).toBeUndefined();

    // The throttled write still belongs to the old photo and carries the last live value.
    await waitFor(() => {
      const writes = fake.calls.filter(
        (call) =>
          call.channel === 'develop:setParams' &&
          (call.args[0] as { photoId: string }).photoId === first.id,
      );
      expect(
        (writes.at(-1)?.args[0] as { params: { Temperature?: number } }).params.Temperature,
      ).toBe(5501);
    });
  });

  it('does not fire global shortcuts while typing digits, minus, dot or comma', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    const before = photoFlags(store.getState(), photo.id).rating;
    const user = userEvent.setup();
    const exposure = field('Exposure value');

    await user.tripleClick(exposure);
    await user.keyboard('-.,4');
    expect(exposure.value).toBe('-.,4');
    expect(photoFlags(store.getState(), photo.id).rating).toBe(before);
    expect(store.getState().module).toBe('develop');

    await user.tab();
    expect(exposure.value).toBe('0');
    expect(params(store).Exposure2012).toBeUndefined();
    // The field has handed the keyboard back: the rating shortcut works again.
    fireEvent.keyDown(window, { key: '4', code: 'Digit4' });
    expect(photoFlags(store.getState(), photo.id).rating).toBe(4);
  });

  it('edits Tint from its as-shot value and clears back to As Shot', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const tint = field('Tint value');
    expect(tint.inputMode).toBe('decimal');

    await user.tripleClick(tint);
    await user.keyboard('-20');
    expect(tint.value).toBe('-20');
    expect(params(store).Tint).toBe(-20);

    await user.tripleClick(tint);
    await user.keyboard('{Backspace}');
    expect(tint.value).toBe('');
    await user.tab();
    await waitFor(() => expect(tint.value).toBe('0'));
    expect(params(store).Tint).toBeUndefined();
  });

  it('uses the relative scale for a JPEG without raw multipliers', async () => {
    const { store } = await renderApp();
    const photo = activePhoto(store.getState());
    if (!photo) throw new Error('no selection');
    act(() =>
      store.setPhotoWhiteBalance(photo.id, {
        asShotMultipliers: { r: 1, g: 1, b: 1 },
        xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      }),
    );
    const user = userEvent.setup();
    const temperature = field('Temperature value');
    await waitFor(() => expect(temperature.value).toBe('0'));
    expect(field('Temperature').min).toBe('-100');
    expect(field('Temperature').max).toBe('100');

    await user.tripleClick(temperature);
    await user.keyboard('5');
    expect(temperature.value).toBe('5');
    expect(params(store).Temperature).toBe(relativeToTemperature(5));
    expect(Number(field('Temperature').value)).toBe(5);

    await user.tripleClick(temperature);
    await user.keyboard('5500');
    expect(temperature.value).toBe('5500');
    expect(params(store).Temperature).toBe(relativeToTemperature(55));
    await user.keyboard('{Enter}');
    expect(temperature.value).toBe('100');
    expect(params(store).Temperature).toBe(relativeToTemperature(100));
  });

  it('shows a value changed elsewhere when the field is not being edited', async () => {
    const { store } = await renderApp();
    const temperature = field('Temperature value');
    act(() => store.setSlider('Temperature', 6500));
    await waitFor(() => expect(temperature.value).toBe('6500'));
  });

  it('does not reset when double-clicking the field, but still resets on the row', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const exposure = field('Exposure value');

    await user.tripleClick(exposure);
    await user.keyboard('2');
    await user.keyboard('{Enter}');
    expect(exposure.value).toBe('2');
    expect(params(store).Exposure2012).toBe(2);

    await user.dblClick(exposure);
    expect(params(store).Exposure2012).toBe(2);
    expect(exposure.value).toBe('2');
    // The double-click selected the text instead of reaching the row's reset.
    expect(exposure.selectionStart).toBe(0);
    expect(exposure.selectionEnd).toBe(exposure.value.length);

    await user.dblClick(screen.getByText('Exposure'));
    expect(params(store).Exposure2012).toBeUndefined();
    expect(exposure.value).toBe('0');
  });
});
