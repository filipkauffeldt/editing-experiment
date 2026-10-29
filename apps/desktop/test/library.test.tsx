import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { baseName, folderOf, libraryFolders, mergeFieldEdits } from '../src/renderer/library';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { mockPhotos, mockSources } from '../src/shared/mock';
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

const cells = (): HTMLElement[] => screen.getAllByTestId('library-cell');
const cell = (fileName: string): HTMLElement => {
  const found = cells().find((element) => element.getAttribute('title')?.startsWith(fileName));
  if (!found) throw new Error(`no grid cell for ${fileName}`);
  return found;
};
const selectedNames = (): string[] =>
  cells()
    .filter((element) => element.getAttribute('aria-selected') === 'true')
    .map((element) => element.getAttribute('title')?.split(' — ')[0] ?? '');
const countText = (): string => screen.getByTestId('library-selection-count').textContent ?? '';

async function openLibrary(): Promise<{ store: AppStore; fake: FakeBridge }> {
  const world = await renderApp();
  await userEvent.setup().keyboard('g');
  await screen.findByTestId('library-grid');
  return world;
}

describe('module switch', () => {
  it('opens Library with G, the loupe with E and Develop with D', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    expect(store.getState().module).toBe('develop');

    await user.keyboard('g');
    expect(await screen.findByTestId('library-grid')).toBeTruthy();
    expect(store.getState().module).toBe('library');

    await user.keyboard('e');
    expect(await screen.findByTestId('library-loupe')).toBeTruthy();
    expect(store.getState().library.view).toBe('loupe');

    await user.keyboard('d');
    expect(await screen.findByTestId('film-strip')).toBeTruthy();
    expect(screen.queryByTestId('library-loupe')).toBeNull();
    expect(store.getState().module).toBe('develop');
  });

  it('does not switch module while typing in a field', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    const caption = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
    caption?.focus();
    await user.keyboard('g');
    expect(store.getState().module).toBe('develop');
  });

  it('shows the module tabs and marks Retouch while a retouch session is open', async () => {
    const { store } = await renderApp();
    const tabs = within(screen.getByRole('tablist', { name: 'Module' }));
    expect(tabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Ingest',
      'Library',
      'Develop',
      'Retouch',
    ]);
    await userEvent.setup().click(tabs.getByRole('tab', { name: 'Retouch' }));
    await waitFor(() => expect(store.getState().retouch).toBeDefined());
    expect(tabs.getByRole('tab', { name: 'Retouch' }).getAttribute('aria-selected')).toBe('true');
    expect(tabs.getByRole('tab', { name: 'Develop' }).getAttribute('aria-selected')).toBe('false');
    await userEvent.setup().click(tabs.getByRole('tab', { name: 'Library' }));
    await waitFor(() => expect(store.getState().retouch).toBeUndefined());
    expect(store.getState().module).toBe('library');
  });
});

describe('library folders', () => {
  it('lists only the local ingest folders, never cards or remote servers', async () => {
    const { store } = await openLibrary();
    const sources = store.getState().sources;
    expect(sources.some((source) => source.kind === 'ftp')).toBe(true);

    const list = within(screen.getByTestId('library-folders'));
    const names = list.getAllByRole('button').map((button) => button.textContent);
    expect(names).toEqual(['All photos40', 'Card A20', 'Pool FTP20']);
    // The Ingesting section names sources on purpose; the Folders list must not.
    const text = screen.getByTestId('library-folders').textContent ?? '';
    for (const source of sources) {
      expect(text).not.toContain(source.name);
      if ('path' in source) expect(text).not.toContain(baseName(source.path));
      if ('host' in source) expect(text).not.toContain(source.host);
    }
  });

  it('derives folders from the photos copies, whatever sources are configured', () => {
    const photos = mockPhotos();
    const folders = libraryFolders(photos);
    expect(folders.map((folder) => folder.path)).toEqual([
      '/mock/ingested/2026-10-24/Card A',
      '/mock/ingested/2026-10-24/Pool FTP',
    ]);
    for (const source of mockSources()) {
      if (source.kind === 'folder') {
        expect(folders.some((folder) => folder.path === source.path)).toBe(false);
      }
    }
    expect(folderOf('C:\\Ingest\\day\\a.nef')).toBe('C:\\Ingest\\day');
    expect(folderOf('/a.nef')).toBe('/');
  });

  it('filters the grid to the chosen folder', async () => {
    await openLibrary();
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('library-folders')).getByText('Pool FTP'));
    expect(cells().every((element) => element.getAttribute('title')?.startsWith('_DSC92'))).toBe(
      true,
    );
  });
});

describe('library multi-select', () => {
  it('selects with click, Shift range, Ctrl toggle and Ctrl+A', async () => {
    const { store } = await openLibrary();
    // The open photo is the selection until something else is picked.
    expect(selectedNames()).toEqual(['_DSC8330.NEF']);

    fireEvent.click(cell('_DSC8330.NEF'));
    expect(selectedNames()).toEqual(['_DSC8330.NEF']);

    fireEvent.click(cell('_DSC8333.NEF'), { shiftKey: true });
    expect(selectedNames()).toEqual([
      '_DSC8330.NEF',
      '_DSC8331.NEF',
      '_DSC8332.NEF',
      '_DSC8333.NEF',
    ]);
    expect(countText()).toContain('4 selected');

    fireEvent.click(cell('_DSC8336.NEF'), { ctrlKey: true });
    expect(selectedNames()).toHaveLength(5);

    fireEvent.click(cell('_DSC8331.NEF'), { metaKey: true });
    expect(selectedNames()).not.toContain('_DSC8331.NEF');
    expect(selectedNames()).toHaveLength(4);

    // A plain click replaces the whole selection and opens that photo.
    fireEvent.click(cell('_DSC8335.NEF'));
    expect(selectedNames()).toEqual(['_DSC8335.NEF']);
    expect(store.getState().selectionAnchor).toBe(store.getState().selectedId);

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    expect(store.getState().selection).toHaveLength(40);
    expect(countText()).toContain('40 selected');
  });

  it('extends a Shift range from the anchor backwards too, in the grid order', async () => {
    const { store } = await openLibrary();
    fireEvent.click(cell('_DSC8335.NEF'));
    fireEvent.click(cell('_DSC8332.NEF'), { shiftKey: true });
    expect(selectedNames()).toEqual([
      '_DSC8332.NEF',
      '_DSC8333.NEF',
      '_DSC8334.NEF',
      '_DSC8335.NEF',
    ]);
    // The anchor stays where the range started.
    fireEvent.click(cell('_DSC8337.NEF'), { shiftKey: true });
    expect(selectedNames()).toEqual(['_DSC8335.NEF', '_DSC8336.NEF', '_DSC8337.NEF']);
    expect(store.getState().selectedId).toBeDefined();
  });

  it('moves and extends the selection with the arrow keys', async () => {
    const { store } = await openLibrary();
    fireEvent.click(cell('_DSC8330.NEF'));
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    expect(selectedNames()).toEqual(['_DSC8330.NEF', '_DSC8331.NEF', '_DSC8332.NEF']);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(selectedNames()).toEqual(['_DSC8333.NEF']);
    expect(store.getState().selection).toHaveLength(1);
  });
});

describe('library batch actions', () => {
  it('tags and untags the whole selection with T in one write', async () => {
    const { store, fake } = await openLibrary();
    fireEvent.click(cell('_DSC8335.NEF'));
    fireEvent.click(cell('_DSC8337.NEF'), { shiftKey: true });
    const ids = store.getState().selection;
    expect(ids).toHaveLength(3);
    const user = userEvent.setup();

    await user.keyboard('t');
    expect(
      store
        .getState()
        .photos.filter((photo) => ids.includes(photo.id))
        .every((p) => p.tagged),
    ).toBe(true);
    await waitFor(() => {
      const writes = fake.calls.filter((call) => call.channel === 'photos:setLabels');
      expect(writes).toHaveLength(1);
      expect(writes[0]?.args[0]).toMatchObject({ photoIds: ids, tagged: true });
    });
    expect(countText()).toContain('3 tagged');

    await user.keyboard('t');
    expect(
      store
        .getState()
        .photos.filter((photo) => ids.includes(photo.id))
        .some((p) => p.tagged),
    ).toBe(false);
  });

  it('sets a colour class on every selected photo from the bar and with 1-8', async () => {
    const { store, fake } = await openLibrary();
    fireEvent.click(cell('_DSC8335.NEF'));
    fireEvent.click(cell('_DSC8336.NEF'), { shiftKey: true });
    const ids = store.getState().selection;
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Set class 5' }));
    expect(
      store
        .getState()
        .photos.filter((p) => ids.includes(p.id))
        .map((p) => p.colorClass),
    ).toEqual([5, 5]);

    await user.keyboard('2');
    expect(
      store
        .getState()
        .photos.filter((p) => ids.includes(p.id))
        .map((p) => p.colorClass),
    ).toEqual([2, 2]);
    await waitFor(() => {
      const last = fake.calls.filter((call) => call.channel === 'photos:setLabels').at(-1);
      expect(last?.args[0]).toMatchObject({ photoIds: ids, colorClass: 2 });
    });
  });

  it('applies caption and IPTC fields to the selection, replacing or appending per field', async () => {
    const { store, fake } = await openLibrary();
    const user = userEvent.setup();
    fireEvent.click(cell('_DSC8330.NEF'));
    fireEvent.click(cell('_DSC8331.NEF'), { shiftKey: true });
    const [first, second] = store.getState().selection;
    if (!first || !second) throw new Error('selection missing');
    const before = await fake.bridge.invoke('metadata:read', { photoId: first });

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    const dialog = await screen.findByTestId('batch-caption-dialog');
    const field = (label: string): HTMLElement => within(dialog).getByLabelText(label);

    await user.type(field('Headline'), 'Derby day');
    await user.type(field('Credit'), 'Sportfotografen');
    await user.selectOptions(field('Caption mode'), 'append');
    await user.type(field('Caption'), 'Photo: Sportfotografen');
    await user.selectOptions(field('Keywords mode'), 'append');
    await user.type(field('Keywords'), 'derby, football');
    await user.click(within(dialog).getByTestId('batch-caption-apply'));

    await waitFor(() => expect(screen.queryByTestId('batch-caption-dialog')).toBeNull());
    const writes = fake.calls.filter((call) => call.channel === 'metadata:write');
    expect(writes.map((call) => (call.args[0] as { photoId: string }).photoId)).toEqual([
      first,
      second,
    ]);

    for (const photoId of [first, second]) {
      const fields = await fake.bridge.invoke('metadata:read', { photoId });
      expect(fields.headline).toBe('Derby day');
      expect(fields.credit).toBe('Sportfotografen');
      expect(fields.caption).toMatch(/Photo: Sportfotografen$/);
      expect(fields.keywords).toEqual(expect.arrayContaining(['derby', 'football']));
    }
    // Append kept what was there; keywords were merged without duplicating.
    const after = await fake.bridge.invoke('metadata:read', { photoId: first });
    expect(after.caption).toBe(`${before.caption} Photo: Sportfotografen`);
    expect(after.keywords).toEqual(expect.arrayContaining(before.keywords ?? []));
    // Untouched fields are not in the write.
    expect(Object.keys((writes[0]?.args[0] as { fields: object }).fields).sort()).toEqual([
      'caption',
      'credit',
      'headline',
      'keywords',
    ]);
  });

  it('sends the selection with Export & send and opens the export dialog with Export…', async () => {
    const { store, fake } = await openLibrary();
    const user = userEvent.setup();
    fireEvent.click(cell('_DSC8335.NEF'));
    fireEvent.click(cell('_DSC8336.NEF'), { shiftKey: true });
    expect(store.getState().selection).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /^Export…/ }));
    expect(await screen.findByTestId('export-dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('export-dialog')).toBeNull());

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      const start = fake.calls.find((call) => call.channel === 'export:start');
      expect((start?.args[0] as { photoIds: string[] }).photoIds).toHaveLength(2);
    });
  });
});

describe('mergeFieldEdits', () => {
  it('replaces text, appends after a space and unions keywords', () => {
    const current = { headline: 'Old', caption: 'Goal.', keywords: ['football'] };
    expect(
      mergeFieldEdits(current, [
        { field: 'headline', value: 'New', mode: 'replace' },
        { field: 'caption', value: 'Credit: x', mode: 'append' },
        { field: 'keywords', value: ['football', 'derby'], mode: 'append' },
        { field: 'city', value: 'Stockholm', mode: 'append' },
      ]),
    ).toEqual({
      headline: 'New',
      caption: 'Goal. Credit: x',
      keywords: ['football', 'derby'],
      city: 'Stockholm',
    });
    expect(
      mergeFieldEdits(current, [{ field: 'keywords', value: ['a'], mode: 'replace' }]),
    ).toEqual({ keywords: ['a'] });
  });
});
