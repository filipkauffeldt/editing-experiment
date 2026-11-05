import { asJobId, type IngestJobInfo, type UploadItem } from '@ee/contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { mockSources, mockUploads } from '../src/shared/mock';
import { createFakeBridge } from './fake-bridge';

const stores: AppStore[] = [];

async function renderApp(
  options: Parameters<typeof createFakeBridge>[0] = {},
): Promise<{ store: AppStore }> {
  const fake = createFakeBridge(options);
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  return { store };
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

  it('shows the active share of the upload queue and opens it', async () => {
    await renderApp({
      handlers: {
        'ingest:status': async () => [],
        'upload:list': async () =>
          uploadsWithStates(['uploading', 'uploading', 'done', 'done', 'done']),
      },
    });

    const summary = screen.getByTestId('upload-summary');
    expect(summary.textContent?.replace(/\s+/g, ' ')).toContain('Sending 2 of 5');
    fireEvent.click(summary);
    expect(await screen.findByRole('dialog', { name: 'Upload queue' })).toBeTruthy();
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
  });
});
