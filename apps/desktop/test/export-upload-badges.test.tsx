import { asExportJobId, asPhotoId, asPresetId, type ExportJob, type Photo } from '@ee/contracts';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import {
  StatusLabels,
  exportBadgesByPhoto,
  type PhotoExportBadge,
} from '../src/renderer/components/PhotoOverlays';
import { createAppStore, type AppStore } from '../src/renderer/store';
import { mockPhotos } from '../src/shared/mock';
import { createFakeBridge } from './fake-bridge';

const basePhoto = (exportState: Photo['status']['export'] = 'none'): Photo => ({
  ...mockPhotos()[0]!,
  versions: [],
  status: {
    ingest: 'done',
    edited: false,
    metadataDiffersFromTemplate: false,
    export: exportState,
    upload: 'none',
  },
});

const job = (
  id: string,
  photos: ExportJob['photos'],
  state: ExportJob['state'] = 'running',
): ExportJob => ({
  id: asExportJobId(id),
  presetId: asPresetId('preset'),
  photoIds: photos.map((photo) => photo.photoId),
  send: [],
  state,
  version: 'develop',
  photos,
  createdAt: 1,
});

const id = (name: string) => asPhotoId(name);

function showBadges({
  photo = basePhoto(),
  percent,
  exportState,
}: {
  photo?: Photo;
  percent?: number;
  exportState?: PhotoExportBadge;
} = {}): HTMLElement {
  render(<StatusLabels photo={photo} percent={percent} exportState={exportState} />);
  return screen.getByTestId('status-labels');
}

describe('export and upload badges', () => {
  it('shows an Exporting spinner for a queued or running photo', () => {
    const badges = showBadges({ exportState: 'exporting' });
    expect(within(badges).getByRole('img', { name: 'Exporting' })).toBeTruthy();
    expect(within(badges).queryByRole('img', { name: 'Exported' })).toBeNull();
  });

  it('shows a static Exported icon and keeps Uploaded next to it', () => {
    const photo = basePhoto('done');
    photo.status.upload = 'done';
    const badges = showBadges({ photo });
    expect(within(badges).getByRole('img', { name: 'Exported' })).toBeTruthy();
    expect(within(badges).getByRole('img', { name: 'Uploaded' })).toBeTruthy();
    expect(within(badges).queryByRole('img', { name: 'Exporting' })).toBeNull();
  });

  it('lets Exporting override the finished icon for the same step', () => {
    const badges = showBadges({ photo: basePhoto('done'), exportState: 'exporting' });
    expect(within(badges).getByRole('img', { name: 'Exporting' })).toBeTruthy();
    expect(within(badges).queryByRole('img', { name: 'Exported' })).toBeNull();
  });

  it('shows no Exported icon when the newest attempt failed or was cancelled', () => {
    const failed = showBadges({ photo: basePhoto('done'), exportState: 'failed' });
    expect(within(failed).queryByRole('img', { name: 'Exported' })).toBeNull();
    expect(within(failed).queryByRole('img', { name: 'Exporting' })).toBeNull();
    cleanup();

    const cancelledState = exportBadgesByPhoto([
      job('cancelled', [{ photoId: id('photo'), state: 'cancelled' }], 'cancelled'),
    ]).get(id('photo'));
    const cancelled = showBadges({
      photo: basePhoto('done'),
      exportState: cancelledState,
    });
    expect(within(cancelled).queryByRole('img', { name: 'Exported' })).toBeNull();
    expect(within(cancelled).queryByRole('img', { name: 'Exporting' })).toBeNull();
    cleanup();

    const failedStatus = showBadges({ photo: basePhoto('failed') });
    expect(within(failedStatus).queryByRole('img', { name: 'Exported' })).toBeNull();
  });

  it('keeps the upload percent and gives uploading its own animated icon', () => {
    const photo = basePhoto('done');
    photo.status.upload = 'uploading';
    const badges = showBadges({ photo, percent: 64 });
    const uploading = within(badges).getByRole('img', { name: 'Uploading 64%' });
    expect(uploading.textContent).toContain('sending 64%');
    expect(uploading.querySelector('svg')).toBeTruthy();
    expect(within(badges).getByRole('img', { name: 'Exported' })).toBeTruthy();
  });

  it('labels a queued upload and fits it beside the Exported icon', () => {
    const photo = basePhoto('done');
    photo.status.upload = 'queued';
    const badges = showBadges({ photo });
    expect(within(badges).getByRole('img', { name: 'Queued for upload' })).toBeTruthy();
    expect(within(badges).getByRole('img', { name: 'Exported' })).toBeTruthy();
  });

  it('is empty for a photo that has neither exported nor uploaded', () => {
    const badges = showBadges();
    expect(badges.textContent).toBe('');
    expect(within(badges).queryByRole('img')).toBeNull();
  });
});

describe('export badges by photo', () => {
  it('maps queued/rendering/exporting to the spinner and the rest to finished or failed', () => {
    const badges = exportBadgesByPhoto([
      job('a', [
        { photoId: id('queued'), state: 'queued' },
        { photoId: id('rendering'), state: 'rendering' },
        { photoId: id('exporting'), state: 'exporting' },
        { photoId: id('sending'), state: 'sending' },
        { photoId: id('done'), state: 'done' },
        { photoId: id('skipped'), state: 'skipped' },
        { photoId: id('failed'), state: 'failed' },
        { photoId: id('cancelled'), state: 'cancelled' },
      ]),
    ]);
    expect([...badges]).toEqual([
      [id('queued'), 'exporting'],
      [id('rendering'), 'exporting'],
      [id('exporting'), 'exporting'],
      [id('sending'), 'exported'],
      [id('done'), 'exported'],
      [id('skipped'), 'exported'],
      [id('failed'), 'failed'],
      [id('cancelled'), 'failed'],
    ]);
  });

  it('lets the newest job win while several jobs run at once', () => {
    const badges = exportBadgesByPhoto([
      job('new', [{ photoId: id('photo'), state: 'exporting' }], 'running'),
      job('old', [{ photoId: id('photo'), state: 'done' }], 'done'),
    ]);
    expect(badges.get(id('photo'))).toBe('exporting');
  });
});

describe('status badges from store events', () => {
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

  const thumbnail = (fileName: string): HTMLElement => {
    const button = document.querySelector<HTMLElement>(`button[title^="${fileName}"]`);
    if (!button) throw new Error(`no thumbnail for ${fileName}`);
    return button;
  };

  it('turns Exporting into Exported from job and photo events in both views', async () => {
    const { store, fake } = await renderApp();
    const photo = store.getState().photos.find((candidate) => candidate.id === id('mock-01'))!;
    const running = job('status-job', [{ photoId: photo.id, state: 'queued' }]);

    act(() => {
      fake.emit('jobs:event', {
        type: 'export.state',
        at: 1,
        jobId: running.id,
        state: 'running',
        job: running,
      });
    });
    await waitFor(() =>
      expect(
        within(thumbnail('_DSC8330.NEF')).getByRole('img', { name: 'Exporting' }),
      ).toBeTruthy(),
    );

    await userEvent.setup().keyboard('g');
    await screen.findByTestId('library-grid');
    const cell = document.querySelector<HTMLElement>('[data-photo-id="mock-01"]');
    if (!cell) throw new Error('no library cell for mock-01');
    expect(within(cell).getByRole('img', { name: 'Exporting' })).toBeTruthy();

    const done = job(
      'status-job',
      [{ photoId: photo.id, state: 'done', path: '/exports/a.jpg' }],
      'done',
    );
    act(() => {
      fake.emit('jobs:event', {
        type: 'export.progress',
        at: 2,
        jobId: done.id,
        photoId: photo.id,
        job: done,
      });
      fake.emit('photos:updated', {
        ...photo,
        status: { ...photo.status, export: 'done' },
      });
    });

    await waitFor(() => expect(within(cell).getByRole('img', { name: 'Exported' })).toBeTruthy());
    expect(
      store.getState().photos.find((candidate) => candidate.id === photo.id)?.status.export,
    ).toBe('done');
  });
});
