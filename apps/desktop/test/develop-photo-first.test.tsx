import { asPhotoId } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { developViewStore } from '../src/renderer/develop-view';
import { activePhoto, createAppStore, paramsForPhoto, type AppStore } from '../src/renderer/store';
import { mockSettings } from '../src/shared/mock';
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
  await waitFor(() => expect(store.getState().selectedId).toBeDefined());
  return { store, fake };
}

afterEach(async () => {
  developViewStore.update((current) => ({ ...current, beforeAfter: 'off', wbPicker: false }));
  for (const store of stores.splice(0)) await store.dispose();
});

const started = (fake: FakeBridge) =>
  fake.calls.filter((call) => call.channel === 'export:start').length;

describe('Develop has no bottom bar', () => {
  it('draws no action bar and no panel titles; the photo footer is the only footer', async () => {
    await renderApp();
    const view = screen.getByTestId('develop-view');
    expect(view.querySelectorAll('footer')).toHaveLength(1);
    expect(within(view).getByTestId('photo-view').querySelector('footer')).not.toBeNull();
    expect(screen.queryByTestId('export-summary')).toBeNull();
    for (const id of ['metadata-panel', 'develop-panel']) {
      expect(within(screen.getByTestId(id)).queryByText(/^(Metadata|Develop)$/i)).toBeNull();
      expect(screen.getByTestId(id).querySelector('header')?.textContent).not.toMatch(
        /^(Metadata|Develop)$/i,
      );
    }
  });

  it('puts Export and the primary Next & send in the filter row, with the preset summary as a tooltip', async () => {
    const { fake } = await renderApp();
    const slot = within(screen.getByTestId('filter-bar')).getByTestId('filter-slot');
    expect(within(slot).getByTestId('open-export')).toBeTruthy();
    const next = within(slot).getByTestId('next-send') as HTMLButtonElement;
    expect(next.textContent).toContain('Next & send');
    expect(next.textContent).toMatch(/(Ctrl|⌘)\+Enter/);
    // The sentence the bottom bar used to print: preset, size, quality, folder, destinations.
    expect(next.title).toMatch(/q\d+ → .+ → /);

    fireEvent.click(next);
    await vi.waitFor(() => expect(started(fake)).toBe(1));
  });

  it('opens the export dialog from the filter row', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('open-export'));
    expect(await screen.findByTestId('export-dialog')).toBeTruthy();
  });

  it('hides Next & send with the filter row on Tab, and Ctrl/Cmd+Enter still sends', async () => {
    const { fake } = await renderApp();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(screen.getByTestId('develop-strips').hasAttribute('hidden')).toBe(true);

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(started(fake)).toBe(1));
  });

  it('lists every key the bar used to hint in the shortcut list', async () => {
    const { store } = await renderApp();
    act(() => store.toggleShortcuts(true));
    const overlay = await screen.findByTestId('shortcuts-overlay');
    const keys = [...overlay.querySelectorAll('kbd')].map((element) => element.textContent);
    for (const key of ['← / →', 'T', '1 – 5', 'Ctrl/⌘ + 1 – 8', 'C', 'R', 'Y', 'J']) {
      expect(keys).toContain(key);
    }
  });
});

describe('Copy settings and the develop tools sit with what they act on', () => {
  it('has Copy settings in the Develop panel, with its dialog', async () => {
    await renderApp();
    const button = within(screen.getByTestId('develop-panel')).getByTestId('open-copy-settings');
    expect(button.textContent).toContain('Copy settings…');
    expect(button.textContent).toMatch(/(Ctrl|⌘)\+C/);
    fireEvent.click(button);
    expect(await screen.findByTestId('copy-settings-dialog')).toBeTruthy();
  });

  it('puts Auto and Pick in the White balance header and Auto in the Tone header', async () => {
    await renderApp();
    const wb = screen.getByTestId('white-balance');
    expect(within(wb).getByTestId('auto-wb').textContent).toBe('Auto');
    expect(within(wb).getByTestId('wb-picker').textContent).toBe('Pick');
    const tone = within(screen.getByTestId('develop-panel'))
      .getByRole('switch', { name: 'Tone on or off' })
      .closest('header') as HTMLElement;
    expect(within(tone).getByTestId('auto-tone').textContent).toBe('Auto');
    // Nothing of the old two-row tool block is left in the panel.
    const panel = screen.getByTestId('develop-panel');
    expect(within(panel).queryByTestId('before-after')).toBeNull();
    expect(within(panel).queryByTestId('split-view')).toBeNull();
    expect(within(panel).queryByText('Auto WB')).toBeNull();
    expect(within(panel).queryByText('Auto tone')).toBeNull();
  });

  it('turns the picker on from the White balance header', async () => {
    await renderApp();
    const pick = screen.getByTestId('wb-picker');
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pick);
    expect(developViewStore.get().wbPicker).toBe(true);
    expect(screen.getByTestId('wb-picker').getAttribute('aria-pressed')).toBe('true');
  });

  it('puts Before and Split in the photo footer, beside Crop and Retouch', async () => {
    await renderApp();
    const footer = within(screen.getByTestId('photo-view')).getByTestId('photo-info')
      .parentElement as HTMLElement;
    const labels = [...footer.querySelectorAll('button')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels.slice(0, 4)).toEqual(['Crop', 'Retouch', 'Before', 'Split']);

    fireEvent.click(within(footer).getByTestId('before-after'));
    expect(developViewStore.get().beforeAfter).toBe('before');
    fireEvent.click(within(footer).getByTestId('split-view'));
    expect(developViewStore.get().beforeAfter).toBe('split');
    fireEvent.click(within(footer).getByTestId('split-view'));
    expect(developViewStore.get().beforeAfter).toBe('off');
  });
});

describe('the photo footer is one info line', () => {
  it('keeps name, size, camera, date and lens in it, with all of it in the tooltip', async () => {
    await renderApp();
    const info = screen.getByTestId('photo-info');
    expect(info.children).toHaveLength(5);
    const text = [...info.children].map((child) => child.textContent);
    expect(text[0]).toBe('_DSC8330.NEF');
    expect(text[1]).toMatch(/^\d+ × \d+$/);
    expect(text[2]).toBe('NIKON Z 9');
    expect(text[3]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(text[4]).toMatch(/^NIKKOR /);
    expect(info.title.split('\n')).toEqual(text);
  });

  it('no longer repeats the file name, size, camera and date in the Metadata panel', async () => {
    await renderApp();
    const panel = screen.getByTestId('metadata-panel');
    expect(within(panel).queryByText('_DSC8330.NEF')).toBeNull();
    expect(panel.textContent).not.toContain('NIKON Z 9');
    expect(panel.textContent).not.toMatch(/\d+ × \d+/);
  });
});

describe('the Metadata panel', () => {
  it('has two rows: template and Apply above, Copy and Paste below; Browse is only in Settings', async () => {
    await renderApp();
    const templateRow = screen.getByTestId('metadata-template-row');
    const copyRow = screen.getByTestId('metadata-copy-row');
    expect(within(templateRow).getByTestId('metadata-template-select')).toBeTruthy();
    expect(within(templateRow).getByTestId('metadata-template-apply').textContent).toBe('Apply');
    expect(within(templateRow).getByRole('button', { name: 'Apply options' })).toBeTruthy();
    expect(within(copyRow).getByTestId('metadata-copy').textContent).toBe('Copy metadata…');
    expect(within(copyRow).getByTestId('metadata-paste').textContent).toBe('Paste');
    expect(within(templateRow).queryByTestId('metadata-copy')).toBeNull();
    expect(within(copyRow).queryByTestId('metadata-template-select')).toBeNull();
    expect(screen.getByTestId('metadata-toolbar').children).toHaveLength(2);
    expect(screen.queryByTestId('metadata-template-browse')).toBeNull();
    expect(screen.queryByLabelText('Template apply mode')).toBeNull();
  });

  it('shows the full template path in the select tooltip', async () => {
    await renderApp();
    const select = screen.getByTestId('metadata-template-select') as HTMLSelectElement;
    expect(select.title).toBe(select.value);
    expect(select.value).toMatch(/\.XMP$/i);
  });

  it('fills empty fields on a plain Apply, whatever the ingest template mode is, and overwrites only from the menu', async () => {
    const { fake } = await renderApp();
    const applied = () =>
      fake.calls
        .filter((call) => call.channel === 'metadata:applyTemplate')
        .map((call) => call.args[0]);
    // The mock ingest settings use Replace; the panel does not read it.
    expect(fake.settings.ingest.metadataTemplateMode).toBe('replace');
    expect(screen.getByTestId('metadata-template-apply').title).toMatch(/fills empty/);
    fireEvent.click(screen.getByTestId('metadata-template-apply'));
    await vi.waitFor(() => expect(applied()).toHaveLength(1));
    expect(applied()[0]).toMatchObject({ mode: 'fillEmpty' });

    // Replace is one step away, named for what it does, and does not stay selected.
    fireEvent.click(within(screen.getByTestId('metadata-apply-mode')).getByRole('button'));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Fill empty fields', 'Replace all, overwriting']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Replace all/ }));
    await vi.waitFor(() => expect(applied()).toHaveLength(2));
    expect(applied()[1]).toMatchObject({ mode: 'replace' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByTestId('metadata-template-apply'));
    await vi.waitFor(() => expect(applied()).toHaveLength(3));
    expect(applied()[2]).toMatchObject({ mode: 'fillEmpty' });
  });

  it('offers a way to Settings, not a select, when there is no template', async () => {
    const settings = mockSettings();
    const { store } = await renderApp({
      handlers: {
        'settings:get': async () => ({
          ...settings,
          metadataTemplates: [],
          ingest: { ...settings.ingest, metadataTemplatePath: undefined },
        }),
      },
    });
    expect(screen.queryByTestId('metadata-template-select')).toBeNull();
    fireEvent.click(screen.getByTestId('metadata-template-settings'));
    expect(store.getState().dialog).toBe('metadata');
  });

  it('puts the caption first, then keywords, headline and object name', async () => {
    await renderApp();
    const fields = within(screen.getByTestId('metadata-fields'));
    const labels = ['Caption', 'Keywords', 'Headline', 'Object name'].map((name) =>
      fields.getByText(name, { selector: 'span' }),
    );
    for (let index = 1; index < labels.length; index++) {
      const earlier = labels[index - 1] as HTMLElement;
      const later = labels[index] as HTMLElement;
      expect(
        earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // All four are in the part that is always shown, before the first folded group.
    const credits = screen.getByTestId('metadata-group-credits');
    expect(
      (labels[3] as HTMLElement).compareDocumentPosition(credits) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('folds Credits, Location and Event / job, each with a summary of what is filled in', async () => {
    await renderApp();
    for (const [id, summary] of [
      ['credits', /Alex Morgan · Staff Photographer · Sportfotografen/],
      ['location', /Manchester · England · United Kingdom · GBR · Etihad Stadium/],
      ['event-job', /Manchester City v Liverpool · NP-20261024-MCILIV/],
    ] as const) {
      const group = screen.getByTestId(`metadata-group-${id}`);
      expect(within(group).getByRole('button', { expanded: false })).toBeTruthy();
      expect(within(group).getByTestId('metadata-group-summary').textContent).toMatch(summary);
      expect(within(group).queryByText('Byline')).toBeNull();
    }
  });

  it('opens a group to its fields, and remembers it when the view is left and come back to', async () => {
    const { store } = await renderApp();
    const credits = () => screen.getByTestId('metadata-group-credits');
    fireEvent.click(within(credits()).getByRole('button', { expanded: false }));
    expect(within(credits()).getByText('Byline')).toBeTruthy();
    expect(within(credits()).queryByTestId('metadata-group-summary')).toBeNull();

    act(() => store.openLibrary('grid'));
    await screen.findByTestId('library-view');
    act(() => store.setModule('develop'));
    await screen.findByTestId('develop-view');
    expect(within(credits()).getByText('Byline')).toBeTruthy();

    fireEvent.click(within(credits()).getByRole('button', { expanded: true }));
    expect(within(credits()).queryByText('Byline')).toBeNull();
  });

  it('shows a value that differs from the template on the folded header', async () => {
    const { store } = await renderApp();
    // Photo 5 has another city and location than the template.
    act(() => store.select(asPhotoId('mock-05')));
    await waitFor(() =>
      expect(screen.getByTestId('metadata-panel').textContent).toContain('Anfield'),
    );
    const location = screen.getByTestId('metadata-group-location');
    expect(within(location).getByRole('button', { expanded: false })).toBeTruthy();
    const mark = within(location).getByTestId('metadata-group-differs');
    expect(mark.textContent).toBe('≠ template');
    expect(mark.title).toContain('City (template: Manchester)');
    expect(mark.title).toContain('Location (template: Etihad Stadium)');
    // The groups that match show nothing.
    expect(
      within(screen.getByTestId('metadata-group-credits')).queryByTestId('metadata-group-differs'),
    ).toBeNull();
  });

  it('keeps the caption and keywords fields mounted while the groups are folded, for Ctrl/Cmd+I and K', async () => {
    await renderApp();
    expect(screen.getByTestId('metadata-group-credits').querySelector('input')).toBeNull();
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    expect(document.activeElement).toBe(document.querySelector('[data-caption-input]'));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(document.querySelector('[data-keywords-input]'));
  });
});

describe('Preset is one row', () => {
  it('shows a label and a menu, and the list only while the menu is open', async () => {
    await renderApp();
    const row = screen.getByTestId('preset-row');
    expect(row.textContent).toContain('Preset');
    expect(screen.queryByTestId('presets')).toBeNull();

    fireEvent.click(within(screen.getByTestId('preset-menu')).getByRole('button'));
    const list = await screen.findByTestId('presets');
    expect(within(list).getAllByTestId('preset-group').length).toBeGreaterThan(0);
    // Refresh and Import are in the menu, not on the panel.
    expect(screen.getByRole('button', { name: 'Refresh presets' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Import/ })).toBeTruthy();
  });

  it('applies a preset from the menu and closes it', async () => {
    const { store } = await renderApp();
    fireEvent.click(within(screen.getByTestId('preset-menu')).getByRole('button'));
    const list = await screen.findByTestId('presets');
    fireEvent.click(await within(list).findByText('Press — Punchy'));
    await waitFor(() =>
      expect(paramsForPhoto(store.getState(), activePhoto(store.getState())).Contrast2012).toBe(15),
    );
    expect(screen.queryByTestId('presets')).toBeNull();
  });
});
