import { INVOKE_CHANNELS, IpcError, channelNamespace } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { createJobsHandlers } from '../src/jobs/handlers';
import { NAMESPACE_HOST } from '../src/shared/routing';

const context = (mock: boolean) => ({ mock, appVersion: '1.2.3', emit: () => {} });

describe('jobs handlers', () => {
  it('echoes pings with the process id of the jobs process', async () => {
    const handlers = createJobsHandlers(context(true));
    const result = await handlers['system:ping']?.({ message: 'hello' });
    expect(result).toMatchObject({ echo: 'hello', jobsPid: process.pid });
  });

  it('reports app version, mock flag and the version of the real native core', async () => {
    const handlers = createJobsHandlers(context(true));
    await expect(handlers['system:info']?.()).resolves.toMatchObject({
      appVersion: '1.2.3',
      mock: true,
      coreVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
  });

  it('serves generated photos only in mock mode', async () => {
    const mock = createJobsHandlers(context(true));
    const real = createJobsHandlers(context(false));

    const photos = await mock['photos:list']?.();
    expect(photos?.length).toBeGreaterThan(1);
    expect(photos?.map((p) => p.fileName)).toEqual(
      [...(photos ?? [])].map((p) => p.fileName).sort(),
    );
    await expect(real['photos:list']?.()).resolves.toEqual([]);
  });

  it('rejects an unknown photo id with not_found', async () => {
    const handlers = createJobsHandlers(context(true));
    const error = await handlers['photos:get']?.({ photoId: 'missing' as never }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({ code: 'not_found' });
  });
});

describe('routing', () => {
  it('assigns every channel namespace to a process', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(['main', 'jobs']).toContain(NAMESPACE_HOST[channelNamespace(channel)]);
    }
  });
});
