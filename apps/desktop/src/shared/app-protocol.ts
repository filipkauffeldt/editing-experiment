import { APP_PROTOCOL } from '@ee/contracts';
import { mockImageSvg } from './mock';

/** Result of resolving an `app://` request; the Electron handler turns it into a `Response`. */
export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

/** Pixel widths of the generated mock images per kind. */
const MOCK_WIDTH = { thumb: 240, preview: 1200 } as const;

const text = (status: number, body: string): AppResponse => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body,
});

/**
 * Resolve an `app://<kind>/<photoId>` request.
 *
 * Stub: real cached JPEGs and the linear image (see `LinearImageHeader`) arrive
 * with the ingest and core workstreams. In mock mode `thumb` and `preview` are
 * generated SVGs so the UI has something to show.
 */
export function resolveAppRequest(rawUrl: string, options: { mock: boolean }): AppResponse {
  const url = new URL(rawUrl);
  if (url.protocol !== `${APP_PROTOCOL}:`) return text(400, 'not an app:// URL');
  const kind = url.hostname;
  const photoId = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (kind !== 'thumb' && kind !== 'preview' && kind !== 'linear') {
    return text(404, `unknown app:// resource "${kind}"`);
  }
  if (options.mock && kind !== 'linear') {
    const svg = mockImageSvg(photoId, { width: MOCK_WIDTH[kind] });
    if (!svg) return text(404, `no such photo "${photoId}"`);
    return { status: 200, headers: { 'content-type': 'image/svg+xml' }, body: svg };
  }
  return text(501, `app://${kind} is not implemented yet`);
}
