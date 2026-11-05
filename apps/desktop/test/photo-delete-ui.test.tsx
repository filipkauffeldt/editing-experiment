import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { asPhotoId, type DeletePhotosResult, type PhotoId } from '@ee/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { nextPhotoAfterRemoval, withoutPhotos } from '../src/renderer/photo-removal';
import { createAppStore, type AppStore } from '../src/renderer/store';
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
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.dispose();
});

const key = (init: KeyboardEventInit): void => {
  act(() => {
    fireEvent.keyDown(window, init);
  });
};
/** A key as the browser delivers it: on the focused element, bubbling through document and window. */
const press = (name: string): Promise<void> => userEvent.setup().keyboard(`{${name}}`);
const callsTo = (fake: FakeBridge, channel: string): PhotoId[][] =>
  fake.calls
    .filter((call) => call.channel === channel)
    .map((call) => (call.args[0] as { photoIds: PhotoId[] }).photoIds);
const deleteCalls = (fake: FakeBridge): PhotoId[][] => callsTo(fake, 'photos:delete');
const removeCalls = (fake: FakeBridge): PhotoId[][] => callsTo(fake, 'photos:removeFromLibrary');

async function openLibrary(options?: Parameters<typeof createFakeBridge>[0]) {
  const world = await renderApp(options);
  await userEvent.setup().keyboard('g');
  await screen.findByTestId('library-grid');
  return world;
}

const cells = (): HTMLElement[] => screen.getAllByTestId('library-cell');
const names = (): string[] =>
  cells().map((element) => element.getAttribute('title')?.split(' — ')[0] ?? '');
const cell = (fileName: string): HTMLElement => {
  const found = cells().find((element) => element.getAttribute('title')?.startsWith(fileName));
  if (!found) throw new Error(`no cell ${fileName}`);
  return found;
};
const selectedNames = (): string[] =>
  cells()
    .filter((element) => element.getAttribute('aria-selected') === 'true')
    .map((element) => element.getAttribute('title')?.split(' — ')[0] ?? '');

describe('delete with the keyboard in the Library', () => {
  it('asks first with the count, cancels on Esc, and deletes the selection on Enter', async () => {
    const { store, fake } = await openLibrary();
    const user = userEvent.setup();
    const all = names();
    const photoCount = store.getState().photos.length;
    await user.click(cell(all[1]!));
    await user.keyboard('{Control>}');
    await user.click(cell(all[2]!));
    await user.keyboard('{/Control}');
    expect(selectedNames()).toEqual([all[1], all[2]]);

    await press('Delete');
    const dialog = await screen.findByTestId('delete-photos-dialog');
    expect(within(dialog).getByTestId('delete-photos-message').textContent).toMatch(
      /2 photos will be moved to the system trash/,
    );
    expect(deleteCalls(fake)).toEqual([]);

    // Esc leaves everything as it was.
    await press('Escape');
    await waitFor(() => expect(screen.queryByTestId('delete-photos-dialog')).toBeNull());
    expect(names()).toEqual(all);

    key({ key: 'Delete' });
    await screen.findByTestId('delete-photos-dialog');
    await press('Enter');
    await waitFor(() => expect(screen.queryByTestId('delete-photos-dialog')).toBeNull());

    expect(deleteCalls(fake)).toHaveLength(1);
    expect(deleteCalls(fake)[0]).toHaveLength(2);
    // Gone from the grid; the next photo after the deleted pair is selected.
    // The grid shows a window of the list: the two are gone, the rest moved up.
    const left = all.filter((name) => name !== all[1] && name !== all[2]);
    expect(names().slice(0, left.length)).toEqual(left);
    expect(selectedNames()).toEqual([all[3]]);
    expect(store.getState().photos.map((photo) => photo.fileName)).not.toContain(all[1]);
    expect(store.getState().photos).toHaveLength(photoCount - 2);
  });

  it('selects the previous photo when the last one was deleted', async () => {
    const { store } = await openLibrary();
    const order = store.getLibraryPhotos().map((photo) => photo.id);
    act(() => store.select(order.at(-1)));
    await press('Delete');
    await screen.findByTestId('delete-photos-dialog');
    await userEvent.setup().click(screen.getByTestId('delete-photos-confirm'));
    await waitFor(() => expect(store.getState().photos).toHaveLength(order.length - 1));
    expect(store.getState().selectedId).toBe(order.at(-2));
    expect(store.getState().selection).toEqual([order.at(-2)]);
  });

  it('removes the deleted photos from the counts, filters and the film strip', async () => {
    const { store } = await openLibrary();
    const before = store.getState().photos.length;
    const victim = store.getState().selectedId!;
    key({ key: 'Delete' });
    await screen.findByTestId('delete-photos-dialog');
    await press('Enter');
    await waitFor(() => expect(store.getState().photos).toHaveLength(before - 1));
    expect(store.getState().photos.some((photo) => photo.id === victim)).toBe(false);
    expect(store.getVisiblePhotos().some((photo) => photo.id === victim)).toBe(false);
    expect(store.getLibraryPhotos()).toHaveLength(before - 1);
    expect(store.getState().selection).not.toContain(victim);
  });
});

describe('delete from the right-click menu', () => {
  it('selects a photo outside the selection first, and the menu deletes just that photo', async () => {
    const { fake } = await openLibrary();
    const user = userEvent.setup();
    const all = names();
    await user.click(cell(all[0]!));

    fireEvent.contextMenu(cell(all[3]!), { clientX: 120, clientY: 80 });

    expect(selectedNames()).toEqual([all[3]]);
    const menu = await screen.findByTestId('photo-menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['UntagT', 'Delete…', 'Remove from Library…']);
    await user.click(screen.getByTestId('photo-menu-delete'));
    expect(screen.queryByTestId('photo-menu')).toBeNull();
    expect(screen.getByTestId('delete-photos-message').textContent).toMatch(/^1 photo will/);
    await user.click(screen.getByTestId('delete-photos-confirm'));
    await waitFor(() => expect(deleteCalls(fake)).toHaveLength(1));
    expect(names()).not.toContain(all[3]);
  });

  it('acts on the whole selection when the clicked photo is inside it', async () => {
    const { store, fake } = await openLibrary();
    const user = userEvent.setup();
    const all = names();
    await user.click(cell(all[0]!));
    await user.keyboard('{Shift>}');
    await user.click(cell(all[2]!));
    await user.keyboard('{/Shift}');
    expect(selectedNames()).toEqual([all[0], all[1], all[2]]);
    const inSelection = [...store.getState().selection];
    expect(inSelection).toHaveLength(3);

    fireEvent.contextMenu(cell(all[1]!), { clientX: 50, clientY: 50 });
    expect(selectedNames()).toEqual([all[0], all[1], all[2]]);
    await user.click(await screen.findByTestId('photo-menu-delete'));
    expect(screen.getByTestId('delete-photos-message').textContent).toMatch(/^3 photos will/);
    await user.click(screen.getByTestId('delete-photos-confirm'));
    await waitFor(() => expect(deleteCalls(fake)).toHaveLength(1));
    expect(deleteCalls(fake)[0]).toEqual(inSelection);
  });

  it('closes on Esc and on a click elsewhere without deleting', async () => {
    const { fake } = await openLibrary();
    const all = names();
    fireEvent.contextMenu(cell(all[0]!), { clientX: 10, clientY: 10 });
    await screen.findByTestId('photo-menu');
    await press('Escape');
    await waitFor(() => expect(screen.queryByTestId('photo-menu')).toBeNull());

    fireEvent.contextMenu(cell(all[0]!), { clientX: 10, clientY: 10 });
    await screen.findByTestId('photo-menu');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId('photo-menu')).toBeNull());
    expect(screen.queryByTestId('delete-photos-dialog')).toBeNull();
    expect(deleteCalls(fake)).toEqual([]);
  });

  it('works on the film strip in Develop and deletes the clicked photo only', async () => {
    const { store, fake } = await renderApp();
    const frames = within(screen.getByTestId('film-strip')).getAllByRole('option');
    const first = store.getState().selectedId;
    fireEvent.contextMenu(frames[2]!, { clientX: 30, clientY: 30 });
    const target = store.getState().selectedId;
    expect(target).not.toBe(first);
    await userEvent.setup().click(await screen.findByTestId('photo-menu-delete'));
    await userEvent.setup().click(screen.getByTestId('delete-photos-confirm'));
    await waitFor(() => expect(deleteCalls(fake)).toEqual([[target]]));
  });
});

describe('delete in Develop', () => {
  it('deletes the open photo only, shows the next one, and Library is the way out when none is left', async () => {
    const photos = mockPhotos().slice(0, 2);
    const { store, fake } = await renderApp({ photos });
    const [a, b] = photos.map((photo) => photo.id);
    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    store.select(a);
    // A multi-selection in the film strip does not widen what Develop deletes.
    key({ key: 'Delete' });
    await screen.findByTestId('delete-photos-dialog');
    expect(screen.getByTestId('delete-photos-message').textContent).toMatch(/^1 photo will/);
    await press('Enter');
    await waitFor(() => expect(store.getState().photos).toHaveLength(1));
    expect(deleteCalls(fake)).toEqual([[a]]);
    expect(store.getState().selectedId).toBe(b);
    expect(store.getState().module).toBe('develop');

    key({ key: 'Delete' });
    await screen.findByTestId('delete-photos-dialog');
    await press('Enter');
    await waitFor(() => expect(store.getState().module).toBe('library'));
    expect(store.getState().photos).toEqual([]);
    expect(store.getState().selectedId).toBeUndefined();
  });
});

describe('when the delete does not go through', () => {
  const failing =
    (failId: () => PhotoId) =>
    async (...args: unknown[]): Promise<DeletePhotosResult> => {
      const { photoIds } = args[0] as { photoIds: PhotoId[] };
      return {
        deleted: photoIds.filter((id) => id !== failId()),
        failed: [
          { photoId: failId(), message: 'DSC_0002.NEF could not be moved to the trash: no trash' },
        ],
      };
    };

  it('keeps the photos that failed, removes the others, and names the failure', async () => {
    const photos = mockPhotos().slice(0, 4);
    let failId = photos[1]!.id;
    const { store } = await openLibrary({
      photos,
      handlers: { 'photos:delete': failing(() => failId) },
    });
    const all = names();
    store.select(photos[0]!.id);
    store.selectAllInLibrary();
    key({ key: 'Delete' });
    await screen.findByTestId('delete-photos-dialog');
    await press('Enter');

    await waitFor(() => expect(store.getState().photos).toHaveLength(1));
    expect(store.getState().photos[0]!.id).toBe(failId);
    expect(names()).toEqual([all[1]]);
    expect(selectedNames()).toEqual([all[1]]);
    const toast = screen.getByTestId('toasts').textContent ?? '';
    expect(toast).toMatch(/3 of 4 photos|were not deleted/);
    expect(toast).toContain('could not be moved to the trash: no trash');
    failId = photos[0]!.id;
  });

  it('reports a failed request and leaves the Library as it was', async () => {
    const { store } = await openLibrary({
      handlers: {
        'photos:delete': async () => {
          throw new Error('the background process is not running');
        },
      },
    });
    const before = store.getState().photos.length;
    key({ key: 'Delete' });
    await screen.findByTestId('delete-photos-dialog');
    await press('Enter');
    await waitFor(() => expect(screen.queryByTestId('delete-photos-dialog')).toBeNull());
    expect(store.getState().photos).toHaveLength(before);
    expect(screen.getByTestId('toasts').textContent).toContain('the background process');
  });
});

describe('Delete never fires where it must not', () => {
  it('ignores it in a text field, with a modifier, in Ingest, and Backspace off the Mac', async () => {
    const { fake, store } = await renderApp();
    const caption = await screen.findByLabelText(/caption/i, { selector: 'textarea' });
    caption.focus();
    fireEvent.keyDown(caption, { key: 'Delete', bubbles: true });
    fireEvent.keyDown(caption, { key: 'Backspace', bubbles: true });
    expect(store.getState().deleteRequest).toBeUndefined();
    (caption as HTMLElement).blur();

    key({ key: 'Delete', ctrlKey: true });
    key({ key: 'Delete', altKey: true });
    key({ key: 'Delete', metaKey: true });
    key({ key: 'Backspace' });
    expect(store.getState().deleteRequest).toBeUndefined();

    act(() => store.setModule('ingest'));
    key({ key: 'Delete' });
    expect(store.getState().deleteRequest).toBeUndefined();
    expect(deleteCalls(fake)).toEqual([]);
  });

  it('ignores it behind a dialog or the shortcut list, and during crop and retouch', async () => {
    const { store } = await renderApp();
    act(() => store.toggleShortcuts(true));
    key({ key: 'Delete' });
    expect(store.getState().deleteRequest).toBeUndefined();
    act(() => store.toggleShortcuts(false));

    act(() => store.openDialog('sources'));
    key({ key: 'Delete' });
    expect(store.getState().deleteRequest).toBeUndefined();
    act(() => store.closeDialog());

    act(() => store.openExportDialog());
    key({ key: 'Delete' });
    expect(store.getState().deleteRequest).toBeUndefined();
    act(() => store.closeExportDialog());

    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    act(() => store.toggleRetouch());
    await waitFor(() => expect(store.getState().retouch).toBeDefined());
    key({ key: 'Delete' });
    expect(store.getState().deleteRequest).toBeUndefined();
    // The right-click menu is off during retouch as well.
    fireEvent.contextMenu(within(screen.getByTestId('film-strip')).getAllByRole('option')[1]!, {
      clientX: 5,
      clientY: 5,
    });
    expect(store.getState().photoMenu).toBeUndefined();
    act(() => store.exitRetouch());

    act(() => store.toggleCrop());
    await waitFor(() => expect(store.getState().crop).toBeDefined());
    key({ key: 'Delete' });
    expect(store.getState().deleteRequest).toBeUndefined();
  });

  it('does not open a second dialog while the first one is open', async () => {
    const { fake } = await openLibrary();
    key({ key: 'Delete' });
    await screen.findByTestId('delete-photos-dialog');
    key({ key: 'Delete' });
    expect(screen.getAllByTestId('delete-photos-dialog')).toHaveLength(1);
    expect(deleteCalls(fake)).toEqual([]);
  });

  it('treats the Mac delete key (Backspace) as Delete on macOS only', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const { store } = await renderApp();
    key({ key: 'Backspace' });
    expect(store.getState().deleteRequest).toBeDefined();
  });
});

describe('what the renderer still holds for a deleted photo', () => {
  it('drops a pending caption save for it and ignores a late update', async () => {
    const { store, fake } = await renderApp();
    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    const id = store.getState().selectedId!;
    // A caption typed just before Delete: its 500 ms save has not gone out yet.
    act(() => store.updateMetadataField(id, 'caption', 'typed just before delete'));
    key({ key: 'Delete' });
    await screen.findByTestId('delete-photos-dialog');
    await press('Enter');
    await waitFor(() => expect(store.getState().photos.some((p) => p.id === id)).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fake.calls.filter((call) => call.channel === 'metadata:write')).toEqual([]);
    expect(store.getState().metadata[id]).toBeUndefined();
    expect(screen.queryByText(/Could not save/)).toBeNull();

    // A late `photos:updated` (or a response) for the deleted photo does not bring it back.
    const ghost = { ...mockPhotos()[0]!, id, rating: 5 };
    act(() => fake.emit('photos:updated', ghost));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.getState().photos.some((photo) => photo.id === id)).toBe(false);
  });

  it('closes a retouch session on a photo that another window deleted', async () => {
    const { store, fake } = await renderApp();
    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    act(() => store.toggleRetouch());
    await waitFor(() => expect(store.getState().retouch).toBeDefined());
    const id = store.getState().retouch!.photoId;
    act(() => fake.emit('photos:removed', { photoId: id }));
    expect(store.getState().retouch).toBeUndefined();
    expect(store.getState().photos.some((photo) => photo.id === id)).toBe(false);
    expect(store.getState().selectedId).not.toBe(id);
  });
});

describe('the shortcut list', () => {
  it('lists Delete and the right-click menu', async () => {
    const { store } = await renderApp();
    act(() => store.toggleShortcuts(true));
    const overlay = await screen.findByRole('dialog');
    expect(overlay.textContent).toMatch(/Delete \(⌫ on a Mac\)/);
    expect(overlay.textContent).toMatch(/Right-click a photo/);
  });
});

describe('nextPhotoAfterRemoval', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'].map(asPhotoId);
  const gone = (...removed: string[]) => new Set(removed.map(asPhotoId));

  it('takes the photo after the removed block, else the one before it', () => {
    expect(nextPhotoAfterRemoval(ids, gone('b'))).toBe('c');
    expect(nextPhotoAfterRemoval(ids, gone('b', 'c'))).toBe('d');
    expect(nextPhotoAfterRemoval(ids, gone('e'))).toBe('d');
    expect(nextPhotoAfterRemoval(ids, gone('d', 'e'))).toBe('c');
    expect(nextPhotoAfterRemoval(ids, gone('a', 'c'))).toBe('d');
  });

  it('has none when everything goes, and falls back to the first when none was in view', () => {
    expect(nextPhotoAfterRemoval(ids, gone('a', 'b', 'c', 'd', 'e'))).toBeUndefined();
    expect(nextPhotoAfterRemoval(ids, gone('zzz'))).toBe('a');
  });

  it('removes per-photo keys by the id before the first colon', () => {
    const record = { a: 1, 'a:active': 2, 'a:develop': 3, b: 4, 'b:active': 5 };
    expect(withoutPhotos(record, gone('a'))).toEqual({ b: 4, 'b:active': 5 });
    expect(withoutPhotos(record, gone('x'))).toBe(record);
  });
});

describe('Remove from Library', () => {
  it('asks with the count and what is left alone, and removes without deleting a file', async () => {
    const { store, fake } = await openLibrary();
    const user = userEvent.setup();
    const all = names();
    const before = store.getState().photos.length;
    await user.click(cell(all[0]!));

    fireEvent.contextMenu(cell(all[3]!), { clientX: 120, clientY: 80 });
    expect(selectedNames()).toEqual([all[3]]);
    const target = store.getState().selectedId;
    await user.click(await screen.findByTestId('photo-menu-remove-from-library'));

    expect(screen.queryByTestId('photo-menu')).toBeNull();
    const dialog = await screen.findByTestId('delete-photos-dialog');
    expect(within(dialog).getByText('Remove from Library')).toBeDefined();
    const text = dialog.textContent ?? '';
    expect(text).toMatch(/1 photo will be removed from the Library/);
    expect(text).toMatch(/edits and ratings in the app/);
    expect(text).toMatch(/Files on disk are not touched/);
    expect(text).not.toMatch(/trash/);
    expect(removeCalls(fake)).toEqual([]);

    await user.click(screen.getByTestId('delete-photos-confirm'));
    await waitFor(() => expect(removeCalls(fake)).toHaveLength(1));
    await waitFor(() => expect(store.getState().photos).toHaveLength(before - 1));
    expect(removeCalls(fake)).toEqual([[target]]);
    expect(deleteCalls(fake)).toEqual([]);
    expect(names()).not.toContain(all[3]);
    // The selection moved on to the next photo, as after a delete.
    expect(selectedNames()).toEqual([all[4]]);
    expect(screen.queryByTestId('toasts')?.textContent ?? '').not.toMatch(
      /error|Could not|not removed/i,
    );
  });

  it('acts on the whole selection when the clicked photo is inside it, and Enter confirms, Esc cancels', async () => {
    const { store, fake } = await openLibrary();
    const user = userEvent.setup();
    const all = names();
    await user.click(cell(all[0]!));
    await user.keyboard('{Shift>}');
    await user.click(cell(all[2]!));
    await user.keyboard('{/Shift}');
    const inSelection = [...store.getState().selection];
    expect(inSelection).toHaveLength(3);

    fireEvent.contextMenu(cell(all[1]!), { clientX: 50, clientY: 50 });
    expect(selectedNames()).toEqual([all[0], all[1], all[2]]);
    await user.click(await screen.findByTestId('photo-menu-remove-from-library'));
    expect(screen.getByTestId('delete-photos-message').textContent).toMatch(
      /^3 photos will be removed from the Library, with their edits/,
    );

    await press('Escape');
    await waitFor(() => expect(screen.queryByTestId('delete-photos-dialog')).toBeNull());
    expect(removeCalls(fake)).toEqual([]);
    expect(names()).toEqual(all);

    fireEvent.contextMenu(cell(all[1]!), { clientX: 50, clientY: 50 });
    await user.click(await screen.findByTestId('photo-menu-remove-from-library'));
    await press('Enter');
    await waitFor(() => expect(screen.queryByTestId('delete-photos-dialog')).toBeNull());
    expect(removeCalls(fake)).toEqual([inSelection]);
    expect(deleteCalls(fake)).toEqual([]);
  });

  it('removes just the clicked photo from the film strip in Develop', async () => {
    const { store, fake } = await renderApp();
    const frames = within(screen.getByTestId('film-strip')).getAllByRole('option');
    fireEvent.contextMenu(frames[2]!, { clientX: 30, clientY: 30 });
    const target = store.getState().selectedId;
    await userEvent.setup().click(await screen.findByTestId('photo-menu-remove-from-library'));
    await userEvent.setup().click(screen.getByTestId('delete-photos-confirm'));
    await waitFor(() => expect(removeCalls(fake)).toEqual([[target]]));
    expect(deleteCalls(fake)).toEqual([]);
  });

  it('drops a pending save for the photo and shows no error', async () => {
    const { store, fake } = await renderApp();
    await waitFor(() => expect(store.getState().selectedId).toBeDefined());
    const id = store.getState().selectedId!;
    act(() => store.updateMetadataField(id, 'caption', 'typed just before removing'));
    act(() => store.requestRemoveFromLibrary());
    await screen.findByTestId('delete-photos-dialog');
    await press('Enter');
    await waitFor(() => expect(store.getState().photos.some((p) => p.id === id)).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fake.calls.filter((call) => call.channel === 'metadata:write')).toEqual([]);
    expect(screen.queryByText(/Could not save/)).toBeNull();
  });

  it('keeps the photos that failed and names the failure', async () => {
    const photos = mockPhotos().slice(0, 3);
    const { store } = await openLibrary({
      photos,
      handlers: {
        'photos:removeFromLibrary': async (...args: unknown[]): Promise<DeletePhotosResult> => {
          const { photoIds } = args[0] as { photoIds: PhotoId[] };
          return {
            deleted: photoIds.filter((id) => id !== photos[1]!.id),
            failed: [{ photoId: photos[1]!.id, message: 'the index is locked' }],
          };
        },
      },
    });
    store.select(photos[0]!.id);
    store.selectAllInLibrary();
    act(() => store.requestRemoveFromLibrary());
    await screen.findByTestId('delete-photos-dialog');
    await press('Enter');
    await waitFor(() => expect(store.getState().photos).toHaveLength(1));
    const toast = screen.getByTestId('toasts').textContent ?? '';
    expect(toast).toMatch(/1 of 3 photos were not removed/);
    expect(toast).toContain('the index is locked');
  });

  it('is not offered where Delete is not: in Ingest and during a dialog', async () => {
    const { store } = await openLibrary();
    act(() => store.requestRemoveFromLibrary());
    await screen.findByTestId('delete-photos-dialog');
    // A second request while one is open changes nothing.
    act(() => store.requestRemoveFromLibrary());
    expect(screen.getAllByTestId('delete-photos-dialog')).toHaveLength(1);
    await press('Escape');
    await waitFor(() => expect(screen.queryByTestId('delete-photos-dialog')).toBeNull());
    act(() => store.setModule('ingest'));
    act(() => store.requestRemoveFromLibrary());
    expect(screen.queryByTestId('delete-photos-dialog')).toBeNull();
  });
});
