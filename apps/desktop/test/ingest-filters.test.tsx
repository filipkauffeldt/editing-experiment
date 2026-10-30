import type { SourceConfig } from '@ee/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp() {
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

const localSource = (store: AppStore): Extract<SourceConfig, { kind: 'folder' | 'card' }> => {
  const source = store
    .getState()
    .sources.find((candidate) => candidate.kind === 'folder' || candidate.kind === 'card');
  if (!source || (source.kind !== 'folder' && source.kind !== 'card')) {
    throw new Error('no local source');
  }
  return source;
};

describe('ingest filters', () => {
  it('shows the three controls per local source on the ingest screen and saves changes', async () => {
    const { store, fake } = await renderApp();
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('status-bar')).getByRole('tab', { name: 'Ingest' }));
    await screen.findByTestId('ingest-view');

    const filters = screen.getAllByTestId('source-filters');
    expect(filters).toHaveLength(1);
    const row = within(filters[0]!);
    expect(row.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');
    expect(row.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect((row.getByLabelText('Incremental') as HTMLInputElement).checked).toBe(true);

    await user.click(row.getByRole('button', { name: 'JPEG' }));
    await waitFor(() => expect(localSource(store).fileTypes).toBe('jpeg'));
    await user.click(row.getByRole('button', { name: 'Locked' }));
    await waitFor(() => expect(localSource(store).lockFilter).toBe('locked'));
    await user.click(row.getByLabelText('Incremental'));
    await waitFor(() => expect(localSource(store).incremental).toBe(false));

    const saved = fake.calls
      .filter((call) => call.channel === 'sources:save')
      .map((call) => (call.args[0] as { source: SourceConfig }).source);
    const last = saved.at(-1);
    expect(last).toMatchObject({ fileTypes: 'jpeg', lockFilter: 'locked', incremental: false });
  });

  it('shows the filtered and incremental counts for a running source', async () => {
    const { store, fake } = await renderApp();
    const user = userEvent.setup();
    const source = localSource(store);
    await store.saveSource({ ...source, lockFilter: 'locked' });
    await user.click(within(screen.getByTestId('status-bar')).getByRole('tab', { name: 'Ingest' }));
    await screen.findByTestId('ingest-view');

    fake.emit('jobs:event', {
      type: 'ingest.progress',
      at: Date.now(),
      jobId: 'test-ingest',
      sourceId: source.id,
      filesTotal: 12,
      filesDone: 3,
      filesScanned: 480,
      filesSkipped: 0,
      bytesDone: 0,
    });
    await waitFor(() =>
      expect(screen.getByTestId('ingest-view').textContent).toContain('12 locked of 480'),
    );

    fake.emit('jobs:event', {
      type: 'ingest.progress',
      at: Date.now(),
      jobId: 'test-ingest',
      sourceId: source.id,
      filesTotal: 142,
      filesDone: 142,
      filesScanned: 480,
      filesSkipped: 338,
      bytesDone: 0,
    });
    await waitFor(() => {
      const text = screen.getByTestId('ingest-view').textContent ?? '';
      expect(text).toContain('142 new · 338 already ingested');
    });
  });

  it('round-trips the controls through the card/folder source settings', async () => {
    const { store, fake } = await renderApp();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('open-settings'));
    const dialog = await screen.findByTestId('settings-dialog');

    const fileTypes = within(dialog).getByRole('group', { name: /File types/ });
    await user.click(within(fileTypes).getByRole('button', { name: 'RAW' }));
    const lock = within(dialog).getByRole('group', { name: /^Lock/ });
    await user.click(within(lock).getByRole('button', { name: 'Unlocked' }));
    const incremental = within(dialog).getByLabelText('Incremental') as HTMLInputElement;
    expect(incremental.checked).toBe(true);
    await user.click(incremental);
    await user.click(within(dialog).getByRole('button', { name: 'Save source' }));

    await waitFor(() => {
      const call = fake.calls.find((candidate) => candidate.channel === 'sources:save');
      expect((call?.args[0] as { source: SourceConfig }).source).toMatchObject({
        fileTypes: 'raw',
        lockFilter: 'unlocked',
        incremental: false,
      });
    });
    expect(localSource(store)).toMatchObject({
      fileTypes: 'raw',
      lockFilter: 'unlocked',
      incremental: false,
    });
  });
});
