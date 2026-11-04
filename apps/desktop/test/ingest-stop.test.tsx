import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

type Handler = (...args: unknown[]) => Promise<unknown>;

async function renderIngest(stop?: Handler) {
  const fake = createFakeBridge(stop ? { handlers: { 'ingest:stop': stop } } : {});
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
  return { store, fake, user };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

describe('stopping ingest from the Ingest view', () => {
  it('stops one source, shows that it is pending and then reads stopped', async () => {
    const stopGate = deferred();
    let callArgs: unknown[] | undefined;
    const { store, fake, user } = await renderIngest(async (...args) => {
      callArgs = args;
      await stopGate.promise;
    });
    const source = store.getState().sources.find((candidate) => candidate.kind === 'folder');
    if (!source) throw new Error('no folder source');
    const row = screen.getByText(source.name).closest('li');
    if (!row) throw new Error('no source row');

    await user.click(within(row).getByRole('button', { name: `Stop ${source.name}` }));

    await waitFor(() => {
      const button = within(row).getByRole('button', { name: `Stop ${source.name}` });
      expect(button.textContent).toContain('Stopping…');
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
    expect(callArgs?.[0]).toEqual({ sourceId: source.id });

    act(() => {
      fake.emit('jobs:event', {
        type: 'ingest.progress',
        at: Date.now(),
        jobId: store.getState().ingest[source.id]!.jobId,
        sourceId: source.id,
        filesTotal: 40,
        filesDone: 12,
        bytesDone: 0,
      });
    });
    await act(async () => stopGate.resolve());
    act(() => {
      fake.emit('jobs:event', {
        type: 'ingest.state',
        at: Date.now(),
        jobId: store.getState().ingest[source.id]!.jobId,
        sourceId: source.id,
        state: 'stopped',
      });
    });

    await waitFor(() => expect(row.textContent).toContain('stopped 12/40'));
    expect(within(row).queryByRole('button', { name: `Stop ${source.name}` })).toBeNull();
    expect(store.getState().ingest[source.id]).toMatchObject({
      state: 'stopped',
      filesDone: 12,
      filesTotal: 40,
      error: undefined,
    });
  });

  it('stops every running and watching source from the start controls', async () => {
    const stopGate = deferred();
    let callArgs: unknown[] | undefined;
    const { store, fake, user } = await renderIngest(async (...args) => {
      callArgs = args;
      await stopGate.promise;
    });
    const active = store.getState().sources;
    const button = screen.getByRole('button', { name: 'Stop all ingests' });

    await user.click(button);

    await waitFor(() => {
      expect(button.textContent).toContain('Stopping…');
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
    expect(callArgs).toEqual([]);
    for (const source of active) {
      const row = screen.getByText(source.name).closest('li');
      if (!row) throw new Error(`no row for ${source.name}`);
      expect(
        (within(row).getByRole('button', { name: `Stop ${source.name}` }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }

    act(() => {
      for (const source of active) {
        fake.emit('jobs:event', {
          type: 'ingest.state',
          at: Date.now(),
          jobId: store.getState().ingest[source.id]!.jobId,
          sourceId: source.id,
          state: 'stopped',
        });
      }
    });
    await act(async () => stopGate.resolve());

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Stop all ingests' })).toBeNull(),
    );
    expect(screen.getByTestId('ingest-view').textContent).toContain('stopped 14/20');
    expect(screen.getByTestId('ingest-view').textContent).toContain('stopped 8/20');
  });
});
