import type { ExportPreset } from '@ee/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createAppStore, type AppStore } from '../src/renderer/store';
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

const lastSettings = (fake: FakeBridge): Record<string, unknown> | undefined => {
  const call = fake.calls.filter((candidate) => candidate.channel === 'settings:set').at(-1);
  return call?.args[0] as Record<string, unknown> | undefined;
};

describe('explicit file naming', () => {
  it('chooses keep or rename in the ingest form and only validates the template for rename', async () => {
    const { fake } = await renderApp();
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('status-bar')).getByRole('tab', { name: 'Ingest' }));
    await screen.findByTestId('ingest-view');

    const naming = screen.getByTestId('ingest-file-naming') as HTMLSelectElement;
    const template = screen.getByTestId('ingest-rename-template') as HTMLInputElement;
    expect(naming.value).toBe('rename');
    expect(template.value).not.toBe('');

    fireEvent.change(template, { target: { value: '{event}_{seq:3}' } });
    fireEvent.change(naming, { target: { value: 'keep' } });
    await waitFor(() => expect(screen.queryByTestId('ingest-rename-template')).toBeNull());

    // Switching back restores the template the user wrote.
    fireEvent.change(screen.getByTestId('ingest-file-naming'), { target: { value: 'rename' } });
    await waitFor(() =>
      expect((screen.getByTestId('ingest-rename-template') as HTMLInputElement).value).toBe(
        '{event}_{seq:3}',
      ),
    );

    // Keeping names saves without a template; the field is only required for Rename.
    fireEvent.change(screen.getByTestId('ingest-rename-template'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('ingest-file-naming'), { target: { value: 'keep' } });
    // Nothing to press: the choice saves itself, without a template for Keep.
    await waitFor(
      () => {
        expect(lastSettings(fake)).toMatchObject({
          ingest: { fileNaming: 'keep', renameTemplate: '' },
        });
      },
      { timeout: 3000 },
    );
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    fireEvent.change(screen.getByTestId('ingest-file-naming'), { target: { value: 'rename' } });
    await waitFor(() =>
      expect((screen.getByTestId('ingest-rename-template') as HTMLInputElement).value).toBe(''),
    );
    const saves = fake.calls.filter((call) => call.channel === 'settings:set').length;
    expect(
      await within(screen.getByTestId('ingest-to')).findByText('Rename template is required'),
    ).toBeTruthy();
    // The bar says it too, and its button waits.
    expect(screen.getByTestId('ingest-summary').textContent).toBe('Rename template is required');
    // A rename with no template is never saved.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(fake.calls.filter((call) => call.channel === 'settings:set')).toHaveLength(saves);
  });

  it('chooses keep or rename per export preset and keeps the template when toggling', async () => {
    const { fake } = await renderApp();
    fireEvent.click(screen.getByTestId('open-export'));
    await screen.findByTestId('export-dialog');

    const naming = screen.getByTestId('export-file-naming') as HTMLSelectElement;
    const template = screen.getByTestId('filename-template') as HTMLInputElement;
    expect(naming.value).toBe('rename');
    expect(template.value).not.toBe('');

    fireEvent.change(template, { target: { value: '{event}_{date}' } });
    fireEvent.change(naming, { target: { value: 'keep' } });
    await waitFor(() => expect(screen.queryByTestId('filename-template')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    await waitFor(() => {
      const call = fake.calls
        .filter((candidate) => candidate.channel === 'exportPresets:save')
        .at(-1);
      expect((call?.args[0] as { preset: ExportPreset }).preset).toMatchObject({
        fileNaming: 'keep',
        fileNameTemplate: '{event}_{date}',
      });
    });

    fireEvent.change(screen.getByTestId('export-file-naming'), { target: { value: 'rename' } });
    await waitFor(() =>
      expect((screen.getByTestId('filename-template') as HTMLInputElement).value).toBe(
        '{event}_{date}',
      ),
    );
  });
});
