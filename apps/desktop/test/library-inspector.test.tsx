import type { IptcFields, PhotoId } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function openLibrary(
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
  await userEvent.setup().keyboard('g');
  await screen.findByTestId('library-grid');
  return { store, fake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const cell = (fileName: string): HTMLElement => {
  const found = screen
    .getAllByTestId('library-cell')
    .find((element) => element.getAttribute('title')?.startsWith(fileName));
  if (!found) throw new Error(`no cell ${fileName}`);
  return found;
};
const inspector = (): HTMLElement => screen.getByTestId('library-inspector');
const info = (): HTMLElement => within(inspector()).getByTestId('library-inspector-info');
const rowValue = (label: string): string => {
  const term = within(info())
    .getAllByText(label)
    .find((element) => element.tagName === 'DT');
  return term?.nextElementSibling?.textContent ?? '';
};
const selectNames = (...names: string[]): void => {
  fireEvent.click(cell(names[0]!));
  for (const name of names.slice(1)) fireEvent.click(cell(name), { ctrlKey: true });
};

describe('Library inspector with one photo', () => {
  it('has no title or preview, and a compact info table without Class or Tagged', async () => {
    await openLibrary();
    fireEvent.click(cell('_DSC8330.NEF'));
    expect(within(inspector()).queryByText(/inspector/i)).toBeNull();
    expect(inspector().querySelector('img')).toBeNull();
    expect(within(inspector()).queryByText('Class')).toBeNull();
    expect(within(inspector()).queryByText('Tagged')).toBeNull();
    expect(rowValue('File')).toBe('_DSC8330.NEF');
    expect(rowValue('Size')).toBe('8256 × 5504');
    expect(rowValue('Taken')).toBe('2026-10-24 14:10:07');
    expect(rowValue('Camera')).toBe('NIKON Z 9');
    expect(rowValue('Lens')).toBe('NIKKOR Z 70-200mm f/2.8 VR S');
  });

  it('edits the caption and the keywords of that photo', async () => {
    const { store, fake } = await openLibrary();
    fireEvent.click(cell('_DSC8330.NEF'));
    const id = store.getState().selectedId!;
    const caption = await within(inspector()).findByRole('textbox', { name: 'Caption' });
    fireEvent.change(caption, { target: { value: 'Kick-off' } });
    expect(store.getState().metadata[id]?.caption).toBe('Kick-off');

    const user = userEvent.setup();
    await user.type(within(inspector()).getByPlaceholderText('Add keyword…'), 'derby{Enter}');
    expect(store.getState().metadata[id]?.keywords).toContain('derby');
    await waitFor(() => {
      const write = fake.calls.filter((call) => call.channel === 'metadata:write').at(-1);
      expect(write?.args[0]).toMatchObject({ photoId: id });
    });
  });

  it('mentions the template only when the metadata differs from it', async () => {
    await openLibrary();
    fireEvent.click(cell('_DSC8330.NEF'));
    expect(screen.queryByTestId('library-template-state')).toBeNull();
    expect(inspector().textContent).not.toContain('Matches the ingest template');

    fireEvent.click(cell('_DSC8334.NEF'));
    expect(screen.getByTestId('library-template-state').textContent).toBe(
      'Differs from the ingest template',
    );
  });
});

describe('Library inspector layout', () => {
  it('puts the inspector on the left and the folders on the right', async () => {
    await openLibrary();
    const view = screen.getByTestId('library-view');
    const inspectorPanel = screen.getByTestId('library-inspector');
    const sidebar = screen.getByTestId('library-sidebar');
    expect(
      inspectorPanel.compareDocumentPosition(sidebar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('panel-resize-library-inspector').getAttribute('data-side')).toBe(
      'left',
    );
    expect(screen.getByTestId('panel-resize-library-sidebar').getAttribute('data-side')).toBe(
      'right',
    );
    expect(view.style.gridTemplateColumns).toBe('300px minmax(0, 1fr) 220px');
  });

  it('keeps the inspector on the left and the folders on the right in the loupe', async () => {
    const { store } = await openLibrary();
    act(() => store.openLibrary('loupe'));
    await screen.findByTestId('library-loupe');
    expect(
      screen
        .getByTestId('library-inspector')
        .compareDocumentPosition(screen.getByTestId('library-sidebar')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('library-view').style.gridTemplateColumns).toBe(
      '300px minmax(0, 1fr) 220px',
    );
  });
});

describe('Library metadata shortcuts', () => {
  it('focuses the caption with Ctrl+I and the keywords with Ctrl+K, and writes what is typed', async () => {
    const { store, fake } = await openLibrary();
    fireEvent.click(cell('_DSC8330.NEF'));
    const id = store.getState().selectedId!;
    const user = userEvent.setup();

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    const caption = within(inspector()).getByRole('textbox', { name: 'Caption' });
    await waitFor(() => expect(document.activeElement).toBe(caption));
    await user.clear(caption);
    await user.type(caption, 'Kick-off');
    expect(store.getState().metadata[id]?.caption).toBe('Kick-off');
    await waitFor(() => {
      const write = fake.calls.filter((call) => call.channel === 'metadata:write').at(-1);
      expect(write?.args[0]).toMatchObject({ photoId: id, fields: { caption: 'Kick-off' } });
    });

    // Escape leaves the field, as it does in Develop.
    fireEvent.keyDown(caption, { key: 'Escape' });
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const keywords = within(inspector()).getByPlaceholderText('Add keyword…');
    await waitFor(() => expect(document.activeElement).toBe(keywords));
    await user.type(keywords, 'derby{Enter}');
    expect(store.getState().metadata[id]?.keywords).toContain('derby');
    await waitFor(() => {
      const write = fake.calls.filter((call) => call.channel === 'metadata:write').at(-1);
      expect(write?.args[0]).toMatchObject({
        photoId: id,
        fields: { keywords: expect.arrayContaining(['derby']) },
      });
    });
  });

  it('expands a known code in the inspector as its closing delimiter is typed', async () => {
    const { store } = await openLibrary();
    await act(async () => {
      await store.refreshCodeReplacements();
    });
    fireEvent.click(cell('_DSC8330.NEF'));
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    const caption = within(inspector()).getByRole('textbox', { name: 'Caption' });
    await waitFor(() => expect(document.activeElement).toBe(caption));
    const user = userEvent.setup();
    await user.clear(caption);
    await user.keyboard('=t1=');
    expect((caption as HTMLTextAreaElement).value).toBe('Manchester City');
  });

  it('shows the panels before it focuses a field when Tab hid them', async () => {
    const { store } = await openLibrary();
    fireEvent.click(cell('_DSC8330.NEF'));
    const view = (): HTMLElement => screen.getByTestId('library-view');

    fireEvent.keyDown(window, { key: 'Tab' });
    expect(view().dataset.panels).toBe('hidden');
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    await waitFor(() => expect(view().dataset.panels).toBe('shown'));
    const caption = within(inspector()).getByRole('textbox', { name: 'Caption' });
    await waitFor(() => expect(document.activeElement).toBe(caption));

    act(() => store.togglePanels());
    expect(view().dataset.panels).toBe('hidden');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(view().dataset.panels).toBe('shown'));
    const keywords = within(inspector()).getByPlaceholderText('Add keyword…');
    await waitFor(() => expect(document.activeElement).toBe(keywords));
  });

  it('opens the batch caption dialog when several photos are selected', async () => {
    const { store } = await openLibrary();
    selectNames('_DSC8330.NEF', '_DSC8331.NEF');
    const user = userEvent.setup();

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    expect(store.getState().batchCaptionOpen).toBe(true);
    expect(await screen.findByTestId('batch-caption-dialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByTestId('batch-caption-dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(dialog.querySelector('[data-keywords-input]')),
    );
  });

  it('does nothing when no photo is selected', async () => {
    const { store } = await openLibrary();
    act(() => store.select(undefined));
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(store.getState().batchCaptionOpen).toBe(false);
    expect(screen.queryByTestId('batch-caption-dialog')).toBeNull();
    expect(document.querySelector('[data-caption-input]')).toBeNull();
    expect(document.querySelector('[data-keywords-input]')).toBeNull();
  });

  it('leaves the grid selection alone while the user moves in a focused field', async () => {
    const { store } = await openLibrary();
    fireEvent.click(cell('_DSC8330.NEF'));
    const id = store.getState().selectedId!;
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    const caption = within(inspector()).getByRole('textbox', { name: 'Caption' });
    await waitFor(() => expect(document.activeElement).toBe(caption));
    fireEvent.keyDown(caption, { key: 'ArrowRight' });
    fireEvent.keyDown(caption, { key: 'ArrowDown' });
    expect(store.getState().selectedId).toBe(id);
    expect(store.getState().selection).toEqual([id]);
  });
});

describe('Library inspector with several photos', () => {
  it('says how many are selected and shows the values they share', async () => {
    await openLibrary();
    selectNames('_DSC8330.NEF', '_DSC8331.NEF', '_DSC8332.NEF');
    expect(screen.getByTestId('library-inspector-count').textContent).toBe('3 selected');
    expect(rowValue('Size')).toBe('8256 × 5504');
    expect(rowValue('Camera')).toBe('NIKON Z 9');
    expect(rowValue('Lens')).toBe('NIKKOR Z 70-200mm f/2.8 VR S');
    expect(rowValue('Taken')).toBe('2026-10-24 14:10:07 to 14:12:07');
    expect(within(inspector()).queryByText('File')).toBeNull();
    expect(within(inspector()).queryByRole('textbox')).toBeNull();
  });

  it('shows Differs for camera and lens, and the taken range across days', async () => {
    await openLibrary();
    selectNames('_DSC8330.NEF', '_DSC9200.NEF');
    expect(rowValue('Camera')).toBe('Differs');
    expect(rowValue('Lens')).toBe('Differs');
    expect(rowValue('Taken')).toBe('2026-10-24 14:10:07 to 15:05:07');
    expect(rowValue('Size')).toBe('8256 × 5504');
  });

  it('shows the shared caption and keywords, then Differs once one photo has others', async () => {
    await openLibrary();
    selectNames('_DSC8330.NEF', '_DSC8331.NEF');
    const caption = screen.getByTestId('library-inspector-caption');
    const keywords = screen.getByTestId('library-inspector-keywords');
    await waitFor(() => expect(caption.textContent).toContain('=t1= {event} at the {location}.'));
    expect(within(keywords).getByText('premier league')).toBeTruthy();
    expect(caption.textContent).not.toContain('Differs');

    fireEvent.click(cell('_DSC8334.NEF'), { ctrlKey: true });
    await waitFor(() => expect(within(caption).getByText('Differs')).toBeTruthy());
    expect(within(keywords).getByText('Differs')).toBeTruthy();
    expect(within(caption).queryByRole('textbox')).toBeNull();
  });

  it('counts the photos that differ from the ingest template', async () => {
    await openLibrary();
    selectNames('_DSC8330.NEF', '_DSC8334.NEF');
    expect(screen.getByTestId('library-template-state').textContent).toBe(
      '1 of 2 differ from the ingest template',
    );
  });

  it('opens the batch dialog from Edit… on the caption and on the keywords', async () => {
    const { store } = await openLibrary();
    selectNames('_DSC8330.NEF', '_DSC8331.NEF');
    const user = userEvent.setup();

    await user.click(within(inspector()).getByRole('button', { name: 'Edit caption of 2 photos' }));
    expect(store.getState().batchCaptionOpen).toBe(true);
    expect(await screen.findByTestId('batch-caption-dialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(store.getState().batchCaptionOpen).toBe(false);

    await user.click(
      within(inspector()).getByRole('button', { name: 'Edit keywords of 2 photos' }),
    );
    expect(store.getState().batchCaptionFocusKeywords).toBe(true);
    const dialog = await screen.findByTestId('batch-caption-dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(dialog.querySelector('[data-keywords-input]')),
    );
  });

  it('reads the fields of every selected photo once to compare them', async () => {
    const reads: PhotoId[] = [];
    const { store } = await openLibrary({
      handlers: {
        'metadata:read': async (...args) => {
          reads.push((args[0] as { photoId: PhotoId }).photoId);
          return {} satisfies IptcFields;
        },
      },
    });
    reads.length = 0;
    store.selectAllInLibrary();
    await waitFor(() => expect(reads.length).toBeGreaterThan(30));
    const caption = screen.getByTestId('library-inspector-caption');
    await waitFor(() => expect(within(caption).getByText('No caption')).toBeTruthy());
    expect(new Set(reads).size).toBe(reads.length);
  });
});

describe('Library bottom bar', () => {
  it('has only the count on the left and the five actions on the right', async () => {
    await openLibrary();
    selectNames('_DSC8330.NEF', '_DSC8331.NEF', '_DSC8332.NEF');
    const bar = screen.getByTestId('library-action-bar');
    expect(within(bar).getByTestId('library-selection-count').textContent).toBe('3 selected');
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent?.replace(/⇧.*$/, '')),
    ).toEqual(['Compare', 'Caption…', 'Sync settings…', 'Export…', 'Export & send']);
    expect(within(bar).getByRole('button', { name: /Export & send/ }).textContent).toMatch(/Enter/);
    expect(within(bar).queryByRole('group')).toBeNull();
    expect(screen.queryByTestId('library-label-hints')).toBeNull();
    expect(bar.textContent).not.toContain('Rating');
  });

  it('opens the batch dialog from Caption… and Sync settings…', async () => {
    const { store } = await openLibrary();
    selectNames('_DSC8330.NEF', '_DSC8331.NEF');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Caption…' }));
    expect(store.getState().batchCaptionOpen).toBe(true);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByTestId('sync-settings'));
    expect(await screen.findByTestId('copy-settings-dialog')).toBeTruthy();
  });
});

describe('Library right-click menu', () => {
  const photosOf = (store: AppStore, ids: readonly PhotoId[]) =>
    store.getState().photos.filter((photo) => ids.includes(photo.id));

  async function openMenuOnSelection(): Promise<{
    store: AppStore;
    fake: FakeBridge;
    ids: PhotoId[];
  }> {
    const world = await openLibrary();
    fireEvent.click(cell('_DSC8335.NEF'));
    fireEvent.click(cell('_DSC8337.NEF'), { shiftKey: true });
    const ids = [...world.store.getState().selection];
    expect(ids).toHaveLength(3);
    fireEvent.contextMenu(cell('_DSC8336.NEF'), { clientX: 60, clientY: 60 });
    await screen.findByTestId('photo-menu');
    return { ...world, ids };
  }

  it('tags the whole selection, then offers Untag', async () => {
    const { store, fake, ids } = await openMenuOnSelection();
    await userEvent.setup().click(screen.getByTestId('photo-menu-tag'));
    expect(photosOf(store, ids).map((photo) => photo.tagged)).toEqual([true, true, true]);
    expect(screen.queryByTestId('photo-menu')).toBeNull();
    await waitFor(() => {
      const write = fake.calls.filter((call) => call.channel === 'photos:setLabels').at(-1);
      expect(write?.args[0]).toMatchObject({ photoIds: ids, tagged: true });
    });

    fireEvent.contextMenu(cell('_DSC8336.NEF'), { clientX: 60, clientY: 60 });
    expect((await screen.findByTestId('photo-menu-tag')).textContent).toContain('Untag');
  });

  it('rates the whole selection, and clears it', async () => {
    const { store, fake, ids } = await openMenuOnSelection();
    const user = userEvent.setup();
    await user.click(
      within(screen.getByTestId('photo-menu')).getByRole('menuitemradio', { name: 'Rate 4' }),
    );
    expect(photosOf(store, ids).map((photo) => photo.rating)).toEqual([4, 4, 4]);
    await waitFor(() => {
      const write = fake.calls.filter((call) => call.channel === 'photos:setLabels').at(-1);
      expect(write?.args[0]).toMatchObject({ photoIds: ids, rating: 4 });
    });

    fireEvent.contextMenu(cell('_DSC8336.NEF'), { clientX: 60, clientY: 60 });
    const rate4 = await screen.findByRole('menuitemradio', { name: 'Rate 4' });
    expect(rate4.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('menuitemradio', { name: 'No rating' }));
    expect(photosOf(store, ids).map((photo) => photo.rating)).toEqual([0, 0, 0]);
  });

  it('sets and clears the colour class of the whole selection', async () => {
    const { store, fake, ids } = await openMenuOnSelection();
    const user = userEvent.setup();
    await user.click(screen.getByRole('menuitemradio', { name: 'Set colour label 6' }));
    expect(photosOf(store, ids).map((photo) => photo.colorClass)).toEqual([6, 6, 6]);
    await waitFor(() => {
      const write = fake.calls.filter((call) => call.channel === 'photos:setLabels').at(-1);
      expect(write?.args[0]).toMatchObject({ photoIds: ids, colorClass: 6 });
    });

    fireEvent.contextMenu(cell('_DSC8336.NEF'), { clientX: 60, clientY: 60 });
    await user.click(await screen.findByRole('menuitemradio', { name: 'Clear colour label' }));
    expect(photosOf(store, ids).map((photo) => photo.colorClass)).toEqual([0, 0, 0]);
  });

  it('keeps Delete… and Remove from Library… below the label rows', async () => {
    await openMenuOnSelection();
    const menu = screen.getByTestId('photo-menu');
    const order = [...menu.querySelectorAll('[role=menuitem],[role=menuitemradio]')].map((item) =>
      item.getAttribute('role'),
    );
    expect(order.at(-2)).toBe('menuitem');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'TagT',
      'Rotate leftCtrl/⌘ ←',
      'Rotate rightCtrl/⌘ →',
      'Shift capture time…',
      'Delete…',
      'Remove from Library…',
    ]);
    expect(
      menu
        .querySelector('[data-testid=photo-menu-delete]')
        ?.compareDocumentPosition(menu.querySelector('[role=group]')!),
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });
});

describe('Library label shortcuts without the bar buttons', () => {
  it('still tag, rate and set a class on the selection with T, 1-5 and Ctrl+1-8', async () => {
    const { store } = await openLibrary();
    selectNames('_DSC8335.NEF', '_DSC8336.NEF');
    const ids = [...store.getState().selection];
    const user = userEvent.setup();
    await user.keyboard('t');
    await user.keyboard('3');
    act(() => {
      fireEvent.keyDown(window, { key: '4', code: 'Digit4', ctrlKey: true });
    });
    const chosen = store.getState().photos.filter((photo) => ids.includes(photo.id));
    expect(chosen.map((photo) => [photo.tagged, photo.rating, photo.colorClass])).toEqual([
      [true, 3, 4],
      [true, 3, 4],
    ]);
  }, 20_000);
});
