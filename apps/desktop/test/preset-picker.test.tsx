import { asPresetId, type EditPreset, type PresetIndex } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { groupPresets } from '../src/renderer/preset-groups';
import { activePhoto, createAppStore, paramsForPhoto, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const preset = (
  name: string,
  group: string | undefined,
  exposure = 0.5,
  id = name,
): EditPreset => ({
  id: asPresetId(id),
  name,
  path: `/presets/${group ?? ''}/${name}.xmp`,
  ...(group === undefined ? {} : { group }),
  params: { Exposure2012: exposure },
});

const PRESETS: EditPreset[] = [
  preset('Kontrast', undefined),
  preset('Kväll', 'Sport/Fotboll', 0.9),
  preset('Dag', 'Sport/Fotboll', 0.1),
  preset('Kväll', 'Hockey', -0.3, 'kvall-hockey'),
];

const stores: AppStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

interface Setup {
  store: AppStore;
  calls: ({ rescan?: boolean } | undefined)[];
}

async function renderApp(
  presets: EditPreset[] = PRESETS,
  problems: PresetIndex['problems'] = [],
): Promise<Setup> {
  const calls: Setup['calls'] = [];
  const fake = createFakeBridge({
    handlers: {
      'develop:presetIndex': async (...args) => {
        calls.push(args[0] as { rescan?: boolean } | undefined);
        return { presets, problems, folders: ['/Adobe/CameraRaw/Settings'] };
      },
    },
  });
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  await waitFor(() => expect(store.getState().selectedId).toBeDefined());
  return { store, calls };
}

/** The presets are one row with a menu; open it to see the list. */
async function openPresetMenu(): Promise<HTMLElement> {
  fireEvent.click(await within(await screen.findByTestId('preset-menu')).findByRole('button'));
  return screen.findByTestId('presets');
}

describe('groupPresets', () => {
  it('puts the ungrouped first, then the groups by name, and keeps presets with the same name apart', () => {
    const groups = groupPresets(PRESETS);
    expect(groups.map((g) => [g.name, g.presets.map((p) => p.id)])).toEqual([
      ['', ['Kontrast']],
      ['Hockey', ['kvall-hockey']],
      ['Sport/Fotboll', ['Kväll', 'Dag']],
    ]);
  });
});

describe('the grouped preset list in Develop', () => {
  it('shows the groups the user organised, with a count, and every preset under its own group', async () => {
    await renderApp();
    const list = await openPresetMenu();
    await waitFor(() => expect(within(list).getAllByTestId('preset-group')).toHaveLength(2));
    const groups = within(list).getAllByTestId('preset-group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Hockey', 'Sport/Fotboll']);
    const sport = within(groups[1] as HTMLElement);
    expect(sport.getByRole('button').textContent).toBe('Sport/Fotboll2');
    expect(sport.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Kväll1',
      'Dag1',
    ]);
    // The two presets that are called Kväll are both there.
    expect(within(list).getAllByText('Kväll')).toHaveLength(2);
    // An ungrouped preset is a plain row before the groups.
    expect(within(list).getByText('Kontrast')).toBeDefined();
  });

  it('applies a preset from a group to the open photo', async () => {
    const { store } = await renderApp();
    const list = await openPresetMenu();
    await waitFor(() => expect(within(list).getByText('Dag')).toBeDefined());
    fireEvent.click(within(list).getByText('Dag'));
    await waitFor(() =>
      expect(paramsForPhoto(store.getState(), activePhoto(store.getState())).Exposure2012).toBe(
        0.1,
      ),
    );
  });

  it('closes and opens a group', async () => {
    await renderApp();
    const list = await openPresetMenu();
    await waitFor(() => expect(within(list).getByText('Dag')).toBeDefined());
    const header = within(list).getByRole('button', { name: /Sport\/Fotboll/ });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(within(list).queryByText('Dag')).toBeNull();
    fireEvent.click(header);
    expect(within(list).getByText('Dag')).toBeDefined();
  });

  it('starts with the groups closed when there are hundreds of presets', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      preset(`Preset ${i}`, i % 2 === 0 ? 'Sport' : 'Porträtt', 0, `p${i}`),
    );
    await renderApp(many);
    const list = await openPresetMenu();
    await waitFor(() => expect(within(list).getAllByTestId('preset-group')).toHaveLength(2));
    const header = within(list).getByRole('button', { name: /^Sport/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(within(list).queryByText('Preset 0')).toBeNull();
    fireEvent.click(header);
    expect(within(list).getByText('Preset 0')).toBeDefined();
    expect(within(list).queryByText('Preset 1')).toBeNull();
  });

  it('reads the folders when it is shown and when Refresh is pressed, and not otherwise', async () => {
    const { calls } = await renderApp();
    await waitFor(() => expect(calls.some((c) => c?.rescan === true)).toBe(true));
    await openPresetMenu();
    const before = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls.length).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh presets' }));
    await waitFor(() => expect(calls.length).toBe(before + 1));
    expect(calls[calls.length - 1]).toEqual({ rescan: true });
  });

  it('says where to add a folder when there are no presets', async () => {
    await renderApp([]);
    await openPresetMenu();
    expect(await screen.findByText(/Add a preset folder in Settings → Presets/)).toBeDefined();
  });
});

describe('the Ingest develop preset select', () => {
  it('groups the presets, and names a saved preset whose file is gone instead of showing another', async () => {
    const { store } = await renderApp();
    const ingest = store.getState().settings?.ingest;
    if (!ingest) throw new Error('settings not loaded');
    await act(async () => {
      await store.saveSettings({ ingest: { ...ingest, developPresetId: asPresetId('gone-uuid') } });
    });
    fireEvent.click(within(screen.getByTestId('status-bar')).getByRole('tab', { name: 'Ingest' }));
    const select = (await screen.findByLabelText('Develop preset')) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByText('Dag')).toBeDefined());
    expect(select.value).toBe('gone-uuid');
    expect(within(select).getByText('gone-uuid (not found)')).toBeDefined();
    const groups = [...select.querySelectorAll('optgroup')].map((g) => [
      g.label,
      [...g.querySelectorAll('option')].map((o) => o.textContent),
    ]);
    expect(groups).toEqual([
      ['Hockey', ['Kväll']],
      ['Sport/Fotboll', ['Kväll', 'Dag']],
    ]);
    expect([...select.options].slice(0, 2).map((o) => o.textContent)).toEqual([
      'None',
      'gone-uuid (not found)',
    ]);
  });
});

describe('Settings → Presets', () => {
  it('lists the folders and what could not be used, and adds and removes a folder', async () => {
    const { store, calls } = await renderApp(PRESETS, [
      { path: '/Adobe/CameraRaw/Settings/Trasig.xmp', reason: 'Not valid XML' },
    ]);
    act(() => store.openDialog('presets'));
    const panel = await screen.findByTestId('presets-settings');
    await waitFor(() => expect(within(panel).getByTestId('presets-summary')).toBeDefined());
    expect(within(panel).getByText('/Adobe/CameraRaw/Settings')).toBeDefined();
    expect(within(panel).getByTestId('presets-summary').textContent).toBe(
      '4 presets, 1 could not be used.',
    );
    expect(within(panel).getByText('/Adobe/CameraRaw/Settings/Trasig.xmp')).toBeDefined();
    expect(within(panel).getByText('Not valid XML')).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: 'Add folder…' }));
    await waitFor(() =>
      expect(store.getState().settings?.presetFolders).toEqual(['/mock/preset.xmp']),
    );
    await waitFor(() => expect(within(panel).getByText('/mock/preset.xmp')).toBeDefined());
    expect(calls[calls.length - 1]).toEqual({ rescan: true });

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(store.getState().settings?.presetFolders).toEqual([]));
  });
});
