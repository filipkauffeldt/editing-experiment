import { asJobId, type IngestJobInfo, type UploadItem } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { mockSources, mockUploads } from '../src/shared/mock';
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
  for (const store of stores.splice(0)) await store.dispose();
});

const barText = (): string =>
  (screen.getByTestId('status-bar').textContent ?? '').replace(/\s+/g, ' ').trim();

const run = (state: IngestJobInfo['state'], done: number, total: number): IngestJobInfo => {
  const source = mockSources()[0]!;
  return {
    jobId: asJobId('test-ingest'),
    sourceId: source.id,
    state,
    filesDone: done,
    filesTotal: total,
    bytesDone: 0,
  };
};

const failedRun = (sourceIndex: number, error: string): IngestJobInfo => ({
  ...run('failed', 0, 0),
  jobId: asJobId(`test-failed-${sourceIndex}`),
  sourceId: mockSources()[sourceIndex]!.id,
  error,
});

const uploadsWithStates = (states: UploadItem['state'][]): UploadItem[] =>
  mockUploads()
    .slice(0, states.length)
    .map((upload, index) => ({ ...upload, state: states[index]! }));

describe('top bar activity', () => {
  it('shows no status while nothing is running', async () => {
    await renderApp({
      handlers: {
        'ingest:status': async () => [],
        'upload:list': async () => [],
      },
    });

    expect(barText()).not.toMatch(/ingest idle/i);
    expect(barText()).not.toMatch(/watching/i);
    expect(barText()).not.toMatch(/sending/i);
    expect(barText()).not.toMatch(/failed/i);
    expect(screen.queryByTestId('ingest-status')).toBeNull();
    expect(screen.queryByTestId('watching-status')).toBeNull();
    expect(screen.queryByTestId('ingest-failed-summary')).toBeNull();
    expect(screen.queryByTestId('upload-summary')).toBeNull();
    expect(screen.queryByTestId('failed-summary')).toBeNull();
    // The things that are always there stay.
    expect(screen.getByRole('tab', { name: 'Ingest' })).toBeTruthy();
    expect(screen.getByTitle('Shortcuts (?)')).toBeTruthy();
    expect(screen.getByTestId('open-settings')).toBeTruthy();
  });

  it('shows ingest progress and a watched FTP server while they are true', async () => {
    const ftp = mockSources().find((source) => source.kind === 'ftp');
    if (!ftp) throw new Error('no ftp source');

    await renderApp({
      handlers: {
        'ingest:status': async () => [
          run('running', 212, 412),
          {
            jobId: asJobId('test-watch'),
            sourceId: ftp.id,
            state: 'watching',
            filesDone: 0,
            filesTotal: 0,
            bytesDone: 0,
          },
        ],
        'upload:list': async () => [],
      },
    });

    expect(screen.getByTestId('ingest-status').textContent?.replace(/\s+/g, ' ')).toContain(
      'Ingesting 212 of 412',
    );
    expect(screen.getByTestId('watching-status').textContent).toContain('Watching FTP');
  });

  it('shows a failed ingest with its source and error and opens Ingest', async () => {
    const { store } = await renderApp({
      handlers: {
        'ingest:status': async () => [
          failedRun(0, 'Card "NIKON Z 9" is not available at /media/filip/NIKON Z 9'),
        ],
        'upload:list': async () => [],
      },
    });

    const failed = screen.getByTestId('ingest-failed-summary');
    expect(failed.textContent?.replace(/\s+/g, ' ')).toContain('1 ingest failed');
    expect(failed.getAttribute('title')).toContain('Card A — Z 9');
    expect(failed.getAttribute('title')).toContain('is not available');

    fireEvent.click(failed);
    expect(await screen.findByTestId('ingest-view')).toBeTruthy();
    expect(store.getState().module).toBe('ingest');
  });

  it('counts failed ingests separately from failed uploads', async () => {
    await renderApp({
      handlers: {
        'ingest:status': async () => [failedRun(0, 'card A failed'), failedRun(1, 'ftps failed')],
        'upload:list': async () => uploadsWithStates(['failed', 'done', 'done', 'done', 'done']),
      },
    });

    const failedIngests = screen.getByTestId('ingest-failed-summary');
    expect(failedIngests.textContent?.replace(/\s+/g, ' ')).toContain('2 ingests failed');
    expect(failedIngests.getAttribute('title')).toContain('Card A — Z 9: card A failed');
    expect(failedIngests.getAttribute('title')).toContain('Pool FTP — Z 8: ftps failed');
    expect(screen.getByTestId('failed-summary').textContent?.replace(/\s+/g, ' ')).toContain(
      '1 failed',
    );
  });

  it('clears a failed ingest when the run restarts or stops', async () => {
    const { fake } = await renderApp({
      handlers: {
        'ingest:status': async () => [failedRun(0, 'card A failed')],
        'upload:list': async () => [],
      },
    });
    const sourceId = mockSources()[0]!.id;
    const jobId = asJobId('test-failed-0');

    act(() => {
      fake.emit('jobs:event', { type: 'ingest.state', at: 0, jobId, sourceId, state: 'running' });
    });
    await waitFor(() => expect(screen.queryByTestId('ingest-failed-summary')).toBeNull());

    act(() => {
      fake.emit('jobs:event', { type: 'ingest.state', at: 0, jobId, sourceId, state: 'failed' });
    });
    await screen.findByTestId('ingest-failed-summary');

    act(() => {
      fake.emit('jobs:event', { type: 'ingest.state', at: 0, jobId, sourceId, state: 'stopped' });
    });
    await waitFor(() => expect(screen.queryByTestId('ingest-failed-summary')).toBeNull());
  });

  it('shows the active share of the upload queue and opens it', async () => {
    await renderApp({
      handlers: {
        'ingest:status': async () => [],
        'upload:list': async () =>
          uploadsWithStates(['uploading', 'uploading', 'done', 'done', 'done']),
      },
    });

    const summary = screen.getByTestId('upload-summary');
    expect(summary.textContent?.replace(/\s+/g, ' ')).toContain('Sending 2');
    expect(summary.textContent).not.toContain('of');
    fireEvent.click(summary);
    const popover = await screen.findByRole('dialog', { name: 'Upload queue' });
    expect(within(popover).getAllByText('Sent')).toHaveLength(3);
  });

  it('keeps the open queue and its finished uploads after the last send finishes', async () => {
    const { store, fake } = await renderApp({
      handlers: {
        'ingest:status': async () => [],
        'upload:list': async () =>
          uploadsWithStates(['uploading', 'queued', 'done', 'done', 'done']),
      },
    });

    fireEvent.click(screen.getByTestId('upload-summary'));
    const popover = await screen.findByRole('dialog', { name: 'Upload queue' });
    expect(within(popover).getAllByText('Sent')).toHaveLength(3);

    for (const item of store
      .getState()
      .uploads.filter((upload) => upload.state === 'queued' || upload.state === 'uploading')) {
      fake.emit('jobs:event', {
        type: 'upload.state',
        at: Date.now(),
        uploadId: item.id,
        photoId: item.photoId,
        destinationId: item.destinationId,
        state: 'done',
      });
    }

    await waitFor(() =>
      expect(
        store
          .getState()
          .uploads.some((upload) => upload.state === 'queued' || upload.state === 'uploading'),
      ).toBe(false),
    );
    expect(screen.queryByTestId('upload-summary')).toBeNull();
    expect(screen.queryByTestId('failed-summary')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Upload queue' })).toBeTruthy();
    expect(within(popover).getAllByText('Sent')).toHaveLength(5);
  });

  it('keeps failures reachable when nothing is being sent', async () => {
    await renderApp({
      handlers: {
        'ingest:status': async () => [],
        'upload:list': async () => uploadsWithStates(['failed', 'done', 'done', 'done', 'done']),
      },
    });

    expect(screen.queryByTestId('upload-summary')).toBeNull();
    const failed = screen.getByTestId('failed-summary');
    expect(failed.textContent?.replace(/\s+/g, ' ')).toContain('1 failed');
    fireEvent.click(failed);
    const popover = await screen.findByRole('dialog', { name: 'Upload queue' });
    expect(within(popover).getByText('Failed')).toBeTruthy();
    expect(within(popover).getAllByText('Sent')).toHaveLength(4);
  });
});
