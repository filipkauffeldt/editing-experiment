import type { DetectedCard } from '@ee/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderIngest(initial: DetectedCard[]) {
  const mounted = { cards: initial };
  const fake = createFakeBridge({
    handlers: { 'sources:detectCards': async () => mounted.cards },
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
  const poll = () => act(() => store.refreshCards());
  return { store, fake, mounted, user, poll };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const z9: DetectedCard = {
  mountPath: '/media/filip/NIKON_Z9',
  volumeLabel: 'NIKON_Z9',
  imageCount: 412,
};

describe('Ingest view cards', () => {
  it('lists an inserted card with label, mount path and image count, unpicked', async () => {
    const { fake } = await renderIngest([z9]);

    const row = await screen.findByTestId('ingest-card');
    expect(within(row).getByText('NIKON_Z9')).toBeTruthy();
    expect(within(row).getByText('/media/filip/NIKON_Z9')).toBeTruthy();
    expect(within(row).getByText('412 images')).toBeTruthy();
    expect(
      (within(row).getByRole('checkbox', { name: 'NIKON_Z9' }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(within(row).queryByTestId('source-filters')).toBeNull();
    expect(fake.calls.some((call) => call.channel === 'ingest:start')).toBe(false);
  });

  it('shows a new card before its image count is ready', async () => {
    const { mounted, poll } = await renderIngest([]);
    expect(await screen.findByText(/No card found/)).toBeTruthy();

    mounted.cards = [{ mountPath: z9.mountPath, volumeLabel: z9.volumeLabel }];
    await poll();
    expect(await screen.findByText('counting…')).toBeTruthy();

    mounted.cards = [z9];
    await poll();
    expect(await screen.findByText('412 images')).toBeTruthy();
  });

  it('picking a card shows its filters and saves them on the card source', async () => {
    const { store, user } = await renderIngest([z9]);
    const row = await screen.findByTestId('ingest-card');

    await user.click(within(row).getByRole('checkbox', { name: 'NIKON_Z9' }));
    const filters = await within(row).findByTestId('source-filters');
    await user.click(within(filters).getByRole('button', { name: 'RAW' }));

    await waitFor(() =>
      expect(
        store.getState().sources.find((source) => source.kind === 'card' && source.discovered),
      ).toMatchObject({ fileTypes: 'raw', mountPath: z9.mountPath }),
    );
    expect(
      (within(row).getByRole('checkbox', { name: 'NIKON_Z9' }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('lists two cards with the same label as separate rows with their own mount paths', async () => {
    await renderIngest([
      { mountPath: '/media/filip/NIKON Z 6', volumeLabel: 'NIKON Z 6', imageCount: 10 },
      { mountPath: '/media/filip/NIKON Z 61', volumeLabel: 'NIKON Z 6', imageCount: 20 },
    ]);

    const rows = await screen.findAllByTestId('ingest-card');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('/media/filip/NIKON Z 6')).toBeTruthy();
    expect(within(rows[1]!).getByText('/media/filip/NIKON Z 61')).toBeTruthy();
  });

  it('removes a card that was pulled out', async () => {
    const { mounted, poll } = await renderIngest([z9]);
    await screen.findByTestId('ingest-card');

    mounted.cards = [];
    await poll();

    await waitFor(() => expect(screen.queryByTestId('ingest-card')).toBeNull());
  });

  it('keeps a pulled card while its ingest runs and shows the error when it fails', async () => {
    const { store, fake, mounted, user, poll } = await renderIngest([z9]);
    const row = await screen.findByTestId('ingest-card');
    await user.click(within(row).getByRole('checkbox', { name: 'NIKON_Z9' }));
    await waitFor(() => expect(store.getState().pickedCards).toHaveLength(1));
    await act(() => store.startIngest(store.getState().settings!.ingest));
    const [sourceId] = store.getState().pickedCards;

    mounted.cards = [];
    await poll();
    const removed = await screen.findByTestId('ingest-card-removed');
    expect(within(removed).getByText('NIKON_Z9')).toBeTruthy();

    act(() => {
      fake.emit('jobs:event', {
        type: 'ingest.state',
        at: 0,
        jobId: store.getState().ingest[sourceId!]!.jobId,
        sourceId,
        state: 'failed',
      });
    });
    await poll();
    expect(screen.getByTestId('ingest-card-removed')).toBeTruthy();
    await user.click(within(screen.getByTestId('ingest-card-removed')).getByText('Dismiss'));
    await waitFor(() => expect(screen.queryByTestId('ingest-card-removed')).toBeNull());
  });

  it('counts only what Ingest will run, and says so when there is nothing to run', async () => {
    const { store, user } = await renderIngest([z9]);
    for (const source of [...store.getState().sources]) await store.removeSource(source.id);
    const row = await screen.findByTestId('ingest-card');
    const form = screen.getByTestId('ingest-view');
    expect(within(form).getByText(/Nothing to ingest/)).toBeTruthy();

    await user.click(within(row).getByRole('checkbox', { name: 'NIKON_Z9' }));
    await waitFor(() => expect(within(form).getByText(/^1 source\(s\): NIKON_Z9$/)).toBeTruthy());
    await user.click(within(row).getByRole('checkbox', { name: 'NIKON_Z9' }));
    await user.click(within(form).getByRole('button', { name: 'Ingest', exact: true }));

    expect(await within(form).findByText(/Nothing to ingest\. Tick a card/)).toBeTruthy();
  });
});
