import { coreVersion } from '@ee/core';
import type { NamespaceHandlers } from '@ee/contracts';
import type { JobsContext } from './index';

export function systemHandlers(context: JobsContext): NamespaceHandlers<'system'> {
  return {
    'system:ping': async ({ message }) => ({
      echo: message,
      jobsPid: process.pid,
      jobsTime: Date.now(),
    }),
    'system:info': async () => ({
      appVersion: context.appVersion,
      // Loading the addon here proves the napi path inside the utility process.
      coreVersion: coreVersion(),
      platform: process.platform,
      mock: context.mock,
    }),
  };
}
