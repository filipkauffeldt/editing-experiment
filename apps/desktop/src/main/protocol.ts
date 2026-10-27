import { APP_PROTOCOL } from '@ee/contracts';
import { protocol } from 'electron';
import { resolveAppRequest } from '../shared/app-protocol';

/** Must run before `app.whenReady()`: schemes have to be declared before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Serve `app://thumb|preview|linear/<photoId>`; see {@link resolveAppRequest}. */
export function handleAppProtocol(options: { mock: boolean }): void {
  protocol.handle(APP_PROTOCOL, (request) => {
    const { status, headers, body } = resolveAppRequest(request.url, options);
    return new Response(body, { status, headers });
  });
}
