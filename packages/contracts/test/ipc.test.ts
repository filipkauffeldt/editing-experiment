import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  IpcError,
  appUrl,
  asPhotoId,
  channelNamespace,
  createBridge,
  notImplemented,
  toIpcResult,
  type ArgsOf,
  type BridgeTransport,
  type EeBridge,
  type EventChannel,
  type InvokeChannel,
  type IpcApi,
  type IpcEvents,
  type IpcNamespace,
  type IpcResult,
  type LinearImageHeader,
  type NamespaceHandlers,
  type Photo,
  type PhotoId,
  type ResultOf,
  type SourceId,
} from '../src/index';

describe('channel registry', () => {
  it('lists exactly the keys of IpcApi and IpcEvents', () => {
    expectTypeOf<(typeof INVOKE_CHANNELS)[number]>().toEqualTypeOf<InvokeChannel>();
    expectTypeOf<(typeof EVENT_CHANNELS)[number]>().toEqualTypeOf<EventChannel>();
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length);
  });

  it('derives the namespace from the channel name', () => {
    expect(channelNamespace('photos:list')).toBe('photos');
    expectTypeOf<IpcNamespace>().toEqualTypeOf<
      | 'system'
      | 'photos'
      | 'ingest'
      | 'sources'
      | 'destinations'
      | 'credentials'
      | 'metadata'
      | 'develop'
      | 'retouch'
      | 'export'
      | 'exportPresets'
      | 'upload'
      | 'settings'
      | 'dialog'
    >();
  });
});

describe('channel types', () => {
  it('derives argument and result types from IpcApi', () => {
    expectTypeOf<ArgsOf<'photos:get'>>().toEqualTypeOf<[args: { photoId: PhotoId }]>();
    expectTypeOf<ArgsOf<'system:info'>>().toEqualTypeOf<[]>();
    expectTypeOf<ResultOf<'photos:list'>>().toEqualTypeOf<Photo[]>();
    expectTypeOf<IpcEvents['photos:added']>().toEqualTypeOf<Photo>();
  });

  it('types the bridge from the channel name', () => {
    // Never called: these are compile-time assertions, checked by `tsc --noEmit`.
    const typeChecks = (bridge: EeBridge): void => {
      expectTypeOf(
        bridge.invoke('photos:get', { photoId: asPhotoId('a') }),
      ).resolves.toEqualTypeOf<Photo>();
      expectTypeOf(bridge.invoke('system:info')).resolves.toHaveProperty('coreVersion');
      // @ts-expect-error wrong argument shape
      void bridge.invoke('photos:get', { id: 'a' });
      // @ts-expect-error no such channel
      void bridge.invoke('photos:nope');
      // @ts-expect-error a PhotoId is not a SourceId
      void bridge.invoke('ingest:stop', { sourceId: asPhotoId('a') });
      bridge.on('photos:added', (photo) => expectTypeOf(photo).toEqualTypeOf<Photo>());
    };
    expect(typeChecks).toBeTypeOf('function');
  });

  it('lets one module implement just its namespace', () => {
    const handlers: NamespaceHandlers<'system'> = {
      'system:ping': async ({ message }) => ({ echo: message, jobsPid: 1, jobsTime: 0 }),
      'system:info': async () => ({
        appVersion: '0',
        coreVersion: '0',
        platform: 'linux',
        mock: true,
      }),
    };
    expectTypeOf(handlers).toHaveProperty('system:ping');
    expectTypeOf<keyof NamespaceHandlers<'system'>>().toEqualTypeOf<
      'system:ping' | 'system:info'
    >();
    expectTypeOf<IpcApi['ingest:stop']>()
      .parameter(0)
      .toEqualTypeOf<{ sourceId?: SourceId } | undefined>();
  });
});

describe('bridge', () => {
  const echoTransport = (
    handler: (channel: InvokeChannel, args: unknown[]) => Promise<unknown>,
  ): BridgeTransport => ({
    invoke: async (channel, args): Promise<IpcResult<unknown>> =>
      toIpcResult(() => handler(channel, args)),
    subscribe: () => () => {},
  });

  it('resolves with the handler value', async () => {
    const bridge = createBridge(
      echoTransport(async (channel, args) => ({ echo: `${channel}:${JSON.stringify(args)}` })),
    );
    await expect(bridge.invoke('system:ping', { message: 'hi' })).resolves.toEqual({
      echo: 'system:ping:[{"message":"hi"}]',
    });
  });

  it('rethrows a handler failure as an IpcError with its code', async () => {
    const bridge = createBridge(
      echoTransport(async (channel) => notImplemented(channel as InvokeChannel)()),
    );
    const error = await bridge.invoke('photos:list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({ code: 'not_implemented' });
  });

  it('maps unexpected errors to code internal', async () => {
    const bridge = createBridge(
      echoTransport(async () => {
        throw new Error('boom');
      }),
    );
    await expect(bridge.invoke('system:info')).rejects.toMatchObject({
      code: 'internal',
      message: 'boom',
    });
  });

  it('forwards events and supports unsubscribing', () => {
    const listeners = new Set<(payload: unknown) => void>();
    const bridge = createBridge({
      invoke: async () => ({ ok: true, value: undefined }),
      subscribe: (_channel, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const seen: string[] = [];
    const stop = bridge.on('photos:updated', (photo) => seen.push(photo.fileName));
    for (const l of listeners) l({ fileName: 'a.nef' });
    stop();
    expect(listeners.size).toBe(0);
    expect(seen).toEqual(['a.nef']);
  });
});

describe('appUrl', () => {
  it('builds app:// URLs and escapes the photo id', () => {
    const id = asPhotoId('a/b c');
    expect(appUrl.thumb(id)).toBe('app://thumb/a%2Fb%20c');
    expect(appUrl.linear(id, 1600.4)).toBe('app://linear/a%2Fb%20c?maxEdge=1600');
    expect(appUrl.preview(asPhotoId('x'))).toBe('app://preview/x');
  });

  it('adds the preview revision so an <img> refreshes, and omits it before any edit', () => {
    const id = asPhotoId('x');
    expect(appUrl.thumb(id, 3)).toBe('app://thumb/x?v=3');
    expect(appUrl.preview(id, 12)).toBe('app://preview/x?v=12');
    expect(appUrl.thumb(id, 0)).toBe('app://thumb/x');
    expect(appUrl.preview(id, undefined)).toBe('app://preview/x');
  });
});

describe('LinearImageHeader', () => {
  it('carries the camera-space decode contract', () => {
    expectTypeOf<LinearImageHeader>().toHaveProperty('asShotMultipliers');
    expectTypeOf<LinearImageHeader>().toHaveProperty('cameraToSrgb').toEqualTypeOf<number[]>();
    expectTypeOf<LinearImageHeader>().toHaveProperty('xyzToCamera').toEqualTypeOf<number[]>();
    // White balance is no longer a header field: it moved to `asShotMultipliers`.
    expectTypeOf<LinearImageHeader>().not.toHaveProperty('whiteBalance');
  });
});
