import type { DetectedCard, IngestConfig } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

const z9: DetectedCard = {
  mountPath: '/media/filip/NIKON_Z9',
  volumeLabel: 'NIKON_Z9',
  imageCount: 412,
};

/** Waits longer than the autosave delay. */
const SAVED = { timeout: 3000 };

async function renderIngest(options: { cards?: DetectedCard[]; failSave?: { on: boolean } } = {}) {
  // A settings write that can be made to fail; when it works it lands in `backing`.
  const backing = createFakeBridge();
  const fake = createFakeBridge({
    handlers: {
      'sources:detectCards': async () => options.cards ?? [],
      ...(options.failSave
        ? {
            'settings:set': async (...args: unknown[]) => {
              if (options.failSave?.on) throw new Error('disk full');
              return backing.bridge.invoke('settings:set', args[0] as never);
            },
          }
        : {}),
    },
  });
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  const user = userEvent.setup();
  await user.click(within(screen.getByTestId('status-bar')).getByRole('tab', { name: 'Ingest' }));
  await screen.findByTestId('ingest-view');
  return { store, fake, user, saved: () => (options.failSave ? backing.settings : fake.settings) };
}

/** The mock world starts with runs going; most tests are about the idle bar. */
function stopRuns(store: AppStore, fake: FakeBridge): void {
  act(() => {
    for (const run of Object.values(store.getState().ingest)) {
      fake.emit('jobs:event', {
        type: 'ingest.state',
        at: 0,
        jobId: run.jobId,
        sourceId: run.sourceId,
        state: 'stopped',
      });
    }
  });
}

const settingsCalls = (fake: FakeBridge): { ingest: Record<string, unknown> }[] =>
  fake.calls
    .filter((call) => call.channel === 'settings:set')
    .map((call) => call.args[0] as { ingest: Record<string, unknown> })
    .filter((patch) => patch.ingest !== undefined);

const startConfig = (fake: FakeBridge): IngestConfig | undefined =>
  (
    fake.calls.filter((call) => call.channel === 'ingest:start').at(-1)?.args[0] as
      { config: IngestConfig } | undefined
  )?.config;

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const previewPath = () => screen.getByTestId('ingest-preview-path').textContent;

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

describe('Ingest view layout', () => {
  it('has From and To, a bar with one action, and no Save or Settings → Ingest', async () => {
    const { user } = await renderIngest();

    expect(screen.getByRole('heading', { name: 'From' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'To' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Sources…|^Destinations…/ })).toBeNull();
    expect(screen.queryByText(/Ingest always copies/)).toBeNull();
    expect(screen.queryByText(/Code replacement files/)).toBeNull();

    await user.click(screen.getByTestId('open-settings'));
    const dialog = await screen.findByTestId('settings-dialog');
    const tabs = within(dialog)
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
    expect(tabs).toEqual(['Sources', 'Destinations', 'Metadata', 'Profiles', 'Presets']);
  });

  it('opens Settings → Sources from the add entry', async () => {
    const { user } = await renderIngest();
    await user.click(screen.getByRole('button', { name: /Folder or server/ }));
    const dialog = await screen.findByTestId('settings-dialog');
    expect(within(dialog).getByRole('tab', { name: 'Sources' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('lists a folder and a server like a card: tickbox, name, kind and one detail line', async () => {
    const { store, user } = await renderIngest({ cards: [z9] });
    const folder = (await screen.findAllByTestId('ingest-source'))[0]!;
    const folderSource = store.getState().sources.find((source) => source.kind === 'folder')!;
    expect(within(folder).getByRole('checkbox', { name: folderSource.name })).toBeTruthy();
    expect(within(folder).getByText('folder')).toBeTruthy();
    expect(within(folder).getByRole('button', { name: /^Filters for/ })).toBeTruthy();

    const server = (await screen.findAllByTestId('ingest-source'))[1]!;
    expect(within(server).getByText('ftp')).toBeTruthy();
    expect(within(server).getByText(/ftp\.sportfotografen\.se/)).toBeTruthy();
    expect(within(server).queryByRole('button', { name: /^Filters for/ })).toBeNull();

    // Unticking leaves it out of the count and of the next ingest.
    await user.click(within(folder).getByRole('checkbox'));
    expect(store.getState().unpickedSources).toEqual([folderSource.id]);
  });
});

describe('Ingest preview', () => {
  it('shows where the first file lands when names are kept, with a subfolder template', async () => {
    await renderIngest();
    fireEvent.change(field('Folder'), { target: { value: '/Photos' } });
    fireEvent.change(field('Subfolder'), { target: { value: '{date:YYYYMMDD}_GAIS-AIK' } });
    fireEvent.change(screen.getByTestId('ingest-file-naming'), { target: { value: 'keep' } });

    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    expect(previewPath()).toBe(`/Photos/${stamp}_GAIS-AIK/_DSC0001.NEF`);
  });

  it('follows the rename template and names the ticked source', async () => {
    const { user } = await renderIngest({ cards: [z9] });
    await user.click(await screen.findByRole('checkbox', { name: 'NIKON_Z9' }));
    fireEvent.change(field('Folder'), { target: { value: '/Photos' } });
    fireEvent.change(field('Subfolder'), { target: { value: '{sourceName}' } });
    fireEvent.change(screen.getByTestId('ingest-rename-template'), {
      target: { value: '{sourceName}_{seq:4}' },
    });

    // Folders and the server are ticked too, and the first of them is the one named.
    expect(previewPath()).toMatch(/^\/Photos\/.+\/.+_0001\.NEF$/);
    fireEvent.change(field('Subfolder'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('ingest-rename-template'), {
      target: { value: '{seq:4}' },
    });
    expect(previewPath()).toBe('/Photos/0001.NEF');
  });

  it('says why a template cannot be used instead of a path', async () => {
    await renderIngest();
    fireEvent.change(field('Subfolder'), { target: { value: '../elsewhere' } });
    expect(screen.getByTestId('ingest-preview-problem').textContent).toMatch(
      /escapes the destination/,
    );
    expect(screen.queryByTestId('ingest-preview-path')).toBeNull();
  });

  it('keeps the unknown-variable message on a template field', async () => {
    await renderIngest();
    fireEvent.change(field('Subfolder'), { target: { value: '{date}/{bogus}' } });
    expect(screen.getByTestId('ingest-subfolder-template-unknown').textContent).toBe(
      'Unknown variable: {bogus}',
    );
  });
});

describe('Ingest settings save themselves', () => {
  it('writes an edit after a pause, trimmed, and nothing for a field that only matches', async () => {
    const { fake } = await renderIngest();
    expect(settingsCalls(fake)).toHaveLength(0);

    fireEvent.change(field('Folder'), { target: { value: ' /Photos ' } });
    fireEvent.change(field('Backup'), { target: { value: '/Backup' } });
    await waitFor(() => expect(settingsCalls(fake)).toHaveLength(1), SAVED);
    expect(settingsCalls(fake)[0]!.ingest).toMatchObject({
      destination: { path: '/Photos' },
      backupDestination: { path: '/Backup' },
    });
  });

  it('shows a failed save, keeps the text on screen and writes it with the next edit', async () => {
    const failSave = { on: true };
    const { saved } = await renderIngest({ failSave });

    fireEvent.change(field('Folder'), { target: { value: '/Photos' } });
    const alert = await screen.findByTestId('ingest-save-error', undefined, SAVED);
    expect(alert.textContent).toContain('Not saved: disk full');
    expect(field('Folder').value).toBe('/Photos');

    failSave.on = false;
    fireEvent.change(field('Backup'), { target: { value: '/Backup' } });
    await waitFor(() => expect(screen.queryByTestId('ingest-save-error')).toBeNull(), SAVED);
    expect(saved().ingest).toMatchObject({
      destination: { path: '/Photos' },
      backupDestination: { path: '/Backup' },
    });
  });

  it('writes a pending edit when the view is left', async () => {
    const { fake, user } = await renderIngest();
    fireEvent.change(field('Folder'), { target: { value: '/Elsewhere' } });
    await user.click(
      within(screen.getByTestId('status-bar')).getByRole('tab', { name: 'Library' }),
    );
    await waitFor(() => expect(settingsCalls(fake)).toHaveLength(1));
    expect(settingsCalls(fake)[0]!.ingest).toMatchObject({ destination: { path: '/Elsewhere' } });
  });

  it('saves the template, its mode and the preset', async () => {
    const { fake } = await renderIngest();
    expect(screen.getByLabelText('Template mode')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Template mode'), { target: { value: 'fillEmpty' } });
    fireEvent.change(screen.getByLabelText('Template'), {
      target: { value: '/mock/templates/night-match.XMP' },
    });
    await waitFor(() => expect(settingsCalls(fake)).toHaveLength(1), SAVED);
    expect(settingsCalls(fake)[0]!.ingest).toMatchObject({
      metadataTemplatePath: '/mock/templates/night-match.XMP',
      metadataTemplateMode: 'fillEmpty',
    });

    // No template, no mode.
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: '' } });
    expect(screen.queryByLabelText('Template mode')).toBeNull();
  });
});

describe('Ingest action', () => {
  it('flushes what is on screen before it starts, and starts with exactly that', async () => {
    const { store, fake, user } = await renderIngest({ cards: [z9] });
    stopRuns(store, fake);
    await user.click(await screen.findByRole('checkbox', { name: 'NIKON_Z9' }));

    // Pressed inside the autosave pause: the edit has not been written yet.
    fireEvent.change(field('Folder'), { target: { value: '/Photos/Match' } });
    expect(settingsCalls(fake)).toHaveLength(0);
    await user.click(
      within(screen.getByTestId('ingest-bar')).getByRole('button', { name: /^Ingest/ }),
    );

    await waitFor(() => expect(startConfig(fake)).toBeDefined());
    expect(startConfig(fake)?.destination.path).toBe('/Photos/Match');
    const order = fake.calls
      .map((call) => call.channel)
      .filter((channel) => channel === 'settings:set' || channel === 'ingest:start');
    expect(order.slice(-2)).toEqual(['settings:set', 'ingest:start']);
    expect(fake.settings.ingest.destination.path).toBe('/Photos/Match');
  });

  it('does not start when the settings could not be saved, and says so', async () => {
    const failSave = { on: true };
    const { store, fake, user } = await renderIngest({ cards: [z9], failSave });
    stopRuns(store, fake);
    await user.click(await screen.findByRole('checkbox', { name: 'NIKON_Z9' }));
    fireEvent.change(field('Folder'), { target: { value: '/Photos/Match' } });
    await user.click(
      within(screen.getByTestId('ingest-bar')).getByRole('button', { name: /^Ingest/ }),
    );

    expect(await screen.findByText(/nothing was started: disk full/)).toBeTruthy();
    expect(startConfig(fake)).toBeUndefined();
  });

  it('says Ingest while a count is unknown and Ingest N photos once every ticked source reports', async () => {
    const { store, fake, user } = await renderIngest({ cards: [z9] });
    stopRuns(store, fake);
    const button = () =>
      within(screen.getByTestId('ingest-bar')).getByRole('button', {
        name: /^Ingest/,
      }) as HTMLButtonElement;
    const row = await screen.findByTestId('ingest-card');

    // The folder and the server are ticked and report no count.
    await user.click(within(row).getByRole('checkbox', { name: 'NIKON_Z9' }));
    expect(button().textContent).toBe('Ingest');

    for (const source of store.getState().sources) store.pickSource(source.id, false);
    await waitFor(() => expect(button().textContent).toBe('Ingest 412 photos'));
    expect(screen.getByTestId('ingest-summary').textContent).toMatch(
      /^1 card · 412 photos → \/mock\/ingested\//,
    );
  });

  it('becomes Stop all while running, and starts only the sources that are not running', async () => {
    const { store, fake, user } = await renderIngest({ cards: [z9] });
    const bar = within(screen.getByTestId('ingest-bar'));
    expect(bar.getByRole('button', { name: 'Stop all ingests' }).textContent).toBe('Stop all');
    // Nothing is left to start: the folder and the server are running.
    expect(bar.queryByRole('button', { name: /^Ingest/ })).toBeNull();

    await user.click(await screen.findByRole('checkbox', { name: 'NIKON_Z9' }));
    const another = await bar.findByRole('button', { name: /^Ingest/ });
    expect(another.textContent).toBe('Ingest 412 photos');
    await user.click(another);

    await waitFor(() => expect(startConfig(fake)).toBeDefined());
    expect(startConfig(fake)?.sources.map((source) => source.name)).toEqual(['NIKON_Z9']);
    expect(store.getState().ingest).toBeDefined();
  });
});

describe('a failed run', () => {
  it('is named in the top bar, which opens Ingest where the source shows the error', async () => {
    const { store, fake, user } = await renderIngest();
    const source = store.getState().sources.find((candidate) => candidate.kind === 'folder')!;
    const jobId = store.getState().ingest[source.id]!.jobId;
    await user.click(
      within(screen.getByTestId('status-bar')).getByRole('tab', { name: 'Library' }),
    );
    expect(screen.queryByTestId('ingest-view')).toBeNull();

    act(() => {
      fake.emit('jobs:event', {
        type: 'job.error',
        at: 0,
        jobId,
        scope: 'ingest',
        message: 'The folder /media/filip/NIKON_Z9 could not be read.',
      });
      fake.emit('jobs:event', {
        type: 'ingest.state',
        at: 0,
        jobId,
        sourceId: source.id,
        state: 'failed',
      });
    });
    const failed = await screen.findByTestId('ingest-failed-summary');
    expect(failed.textContent).toContain('1 ingest failed');
    expect(failed.title).toContain('could not be read');

    await user.click(failed);
    const row = (await screen.findAllByTestId('ingest-source')).find((item) =>
      within(item).queryByText(source.name),
    )!;
    expect(row.textContent).toContain('failed');
    expect(row.textContent).toContain('The folder /media/filip/NIKON_Z9 could not be read.');
    // The other runs still go, so the bar still offers Stop all.
    expect(
      within(screen.getByTestId('ingest-bar')).getByRole('button', { name: 'Stop all ingests' }),
    ).toBeTruthy();
  });
});
