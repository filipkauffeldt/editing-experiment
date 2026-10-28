import { APP_PROTOCOL, LINEAR_IMAGE_HEADER } from '@ee/contracts';
import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { Readable } from 'node:stream';
import { resolveAppRequest } from '../shared/app-protocol';
import type { AppBackendResponse } from '../shared/jobs-protocol';

/** Must run before `app.whenReady()`: schemes have to be declared before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL,
      // `corsEnabled`: the renderer fetches `app://linear/...` from another origin
      // and needs the response headers, which CORS has to allow.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** Lets the renderer (any origin: `file://` or the dev server) read these responses. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': [LINEAR_IMAGE_HEADER, 'content-length'].join(', '),
};

export interface AppProtocolOptions {
  mock: boolean;
  /** Resolve a request in the jobs process. Required outside mock mode. */
  resolveInJobs?: (url: string) => Promise<AppBackendResponse>;
  /** Files outside this directory are never served, whatever the jobs process says. */
  cacheDir: string;
}

const insideDirectory = (directory: string, file: string): boolean => {
  const rel = relative(directory, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

function toResponse(answer: AppBackendResponse, cacheDir: string): Response {
  const headers = { ...answer.headers, ...CORS_HEADERS };
  if (answer.file === undefined)
    return new Response(answer.body ?? null, { status: answer.status, headers });
  if (!isAbsolute(answer.file) || !insideDirectory(cacheDir, answer.file)) {
    return new Response('refusing to serve a file outside the cache', {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
  // Streamed from disk: main never holds the image in memory.
  const body = Readable.toWeb(
    createReadStream(answer.file),
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status: answer.status, headers });
}

/**
 * Serve `app://thumb|preview|linear/<photoId>`. Mock mode answers with generated
 * images (see {@link resolveAppRequest}); otherwise the jobs process answers
 * and main only streams the file it names.
 */
export function handleAppProtocol(options: AppProtocolOptions): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    if (options.mock || !options.resolveInJobs) {
      const { status, headers, body } = resolveAppRequest(request.url, { mock: options.mock });
      return new Response(body as BodyInit, { status, headers: { ...headers, ...CORS_HEADERS } });
    }
    try {
      return toResponse(await options.resolveInJobs(request.url), options.cacheDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 502, headers: CORS_HEADERS });
    }
  });
}
