/// <reference lib="webworker" />
import type { DevelopWorkerRequest, DevelopWorkerResponse } from './develop-render';
import { renderDevelopRgba } from './develop-render';

interface WorkerScope {
  postMessage(message: DevelopWorkerResponse, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<DevelopWorkerRequest>) => void,
  ): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
  const request = event.data;
  try {
    const result = renderDevelopRgba({
      header: request.header,
      data: request.data,
      params: request.params,
      ops: request.ops,
      width: request.width,
      height: request.height,
    });
    const rgba = result.rgba.buffer.slice(
      result.rgba.byteOffset,
      result.rgba.byteOffset + result.rgba.byteLength,
    ) as ArrayBuffer;
    scope.postMessage(
      { id: request.id, ok: true, width: result.width, height: result.height, rgba },
      [rgba],
    );
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
