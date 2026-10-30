import {
  LINEAR_IMAGE_HEADER,
  appUrl,
  type LinearImageHeader,
  type Photo,
  type Rect,
  type Shape,
} from '@ee/contracts';
import {
  correctedShapes,
  autoToneBasis,
  autoWhiteBalance,
  beforeParams,
  createDevelopRenderer,
  profileColorModel,
  cropDevelopedRgba,
  cropGeometry,
  croppedToSourcePixels,
  grainSeedFromId,
  cropOutputSize,
  predictAutoTone,
  whiteBalanceFromPatch,
  type CropViewTransform,
  type DevelopRenderer,
  withoutLensGeometry,
} from '@ee/develop-gl';
import { applyMosaic, magicWand, shapeBounds, simplifyPolygon } from '@ee/retouch';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ee } from '../ee';
import {
  namesProfile,
  paramsForPhoto,
  topRetouchVersion,
  type RetouchFace,
  type RetouchTool,
} from '../store';
import {
  clearDevelopAction,
  setHistogram,
  setSplit,
  setWbPicker,
  useDevelopViewMode,
} from '../develop-view';
import { cropFit, cropLayout, fitWithin } from '../crop-view';
import { detectionRegion, faceStoredShape } from '../retouch-geometry';
import { useAppState, useAppStore } from '../store-context';
import { CropOverlay } from './CropOverlay';
import { CropToolbar } from './CropToolbar';
import { EyeIcon, PenIcon } from './icons';
import styles from './PhotoCanvas.module.css';

interface LoadedImage {
  header: LinearImageHeader;
  data: ArrayBuffer;
}

const MIN_EDGE = 64;
const MAX_EDGE = 2560;
const EDGE_BUCKET = 64;

/** Crop mode: the image outside the frame is multiplied by this. */
const CROP_DIM = 0.42;
/** The empty canvas outside the rotated image (sRGB), a touch lighter than the app background. */
const CROP_OUTSIDE: [number, number, number] = [0.1, 0.1, 0.11];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizedPoint = (event: React.PointerEvent, element: Element): { x: number; y: number } => {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
    y: clamp01((event.clientY - rect.top) / Math.max(1, rect.height)),
  };
};

const rectFromPoints = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  type: 'rect',
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
});

const shapePath = (shape: Shape): string => {
  if (shape.type === 'rect') {
    return `M ${shape.x} ${shape.y} h ${shape.w} v ${shape.h} h ${-shape.w} Z`;
  }
  if (shape.points.length === 0) return '';
  return `${shape.points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ')} Z`;
};

const shapeBox = (shape: Shape): { x: number; y: number; w: number; h: number } =>
  shapeBounds(shape);

const TOOL_LABELS: Record<RetouchTool, string> = {
  rect: 'Rectangle',
  lasso: 'Lasso',
  wand: 'Magic wand',
  faces: 'Detect faces',
};

function Toolbar() {
  const store = useAppStore();
  const state = useAppState();
  const session = state.retouch;
  if (!session) return null;
  const enabledFaces = session.faces.filter((face) => face.enabled).length;
  return (
    <div className={styles.toolbar} data-testid="retouch-toolbar">
      <div className={styles.tools}>
        {(Object.keys(TOOL_LABELS) as RetouchTool[]).map((tool) => (
          <button
            key={tool}
            type="button"
            className={`${styles.tool} ${session.tool === tool ? styles.toolActive : ''}`}
            onClick={() => store.setRetouchTool(tool)}
            data-tool={tool}
          >
            {TOOL_LABELS[tool]}
          </button>
        ))}
      </div>
      {session.tool === 'wand' && (
        <label className={styles.control}>
          <span>Tolerance {Math.round(session.tolerance)}</span>
          <input
            type="range"
            min={0}
            max={60}
            step={1}
            value={session.tolerance}
            aria-label="Magic wand tolerance"
            onChange={(event) => store.setRetouchTolerance(Number(event.target.value))}
          />
        </label>
      )}
      <label className={styles.control}>
        <span>Block size {(session.blockSizeRel * 100).toFixed(1)}%</span>
        <input
          type="range"
          min={0.002}
          max={0.04}
          step={0.001}
          value={session.blockSizeRel}
          aria-label="Mosaic block size"
          onChange={(event) => store.setRetouchBlockSize(Number(event.target.value))}
        />
      </label>
      {(session.tool === 'faces' || session.faces.length > 0) && (
        <label className={styles.control}>
          <span>Face padding {Math.round(session.facePadding * 100)}%</span>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={session.facePadding}
            aria-label="Face padding"
            onChange={(event) => store.setRetouchFacePadding(Number(event.target.value))}
          />
        </label>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => store.undoRetouchShape()}
          disabled={session.shapes.length === 0}
          title="Undo the last shape (Ctrl/⌘+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void store.deleteRetouchVersion()}
        >
          Delete version
        </button>
        <button type="button" className={styles.secondary} onClick={() => store.exitRetouch()}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.commit}
          onClick={() => void store.commitRetouch()}
          disabled={session.busy}
          data-testid="commit-retouch"
        >
          <PenIcon size={11} /> {session.busy ? 'Saving…' : 'Mosaic'}
        </button>
      </div>
      {session.faces.length > 0 && (
        <div className={styles.faceHint}>
          <EyeIcon size={10} /> {enabledFaces}/{session.faces.length} faces selected
        </div>
      )}
      <div className={styles.toolHint}>
        {session.tool === 'faces'
          ? 'Drag a rough area around the faces.'
          : session.tool === 'wand'
            ? 'Click a colour region.'
            : session.tool === 'lasso'
              ? 'Draw a freehand outline.'
              : 'Drag a rectangle around what to pixelate.'}
      </div>
    </div>
  );
}

function CanvasForPhoto({ photo }: { photo: Photo }) {
  const store = useAppStore();
  const state = useAppState();
  const params = paramsForPhoto(state, photo);
  const lensContext = state.photoLens[photo.id];
  const profileState = state.photoProfiles[photo.id];
  const lookAmount = params.LookAmount;
  // The profile the settings name, or null (none named, not on this machine). The canvas waits for
  // a named profile to load, so a photo never flashes in the camera-matrix colours first.
  const profile = useMemo(
    () =>
      profileState?.status === 'ok' && profileState.profile
        ? { ...profileState.profile, amount: lookAmount ?? 1 }
        : null,
    [profileState, lookAmount],
  );
  const profilePending =
    namesProfile(params) && (profileState === undefined || profileState.status === 'loading');
  const session = state.retouch?.photoId === photo.id ? state.retouch : undefined;
  const cropSession = state.crop?.photoId === photo.id ? state.crop : undefined;
  const image = state.photos.find((candidate) => candidate.id === photo.id) ?? photo;
  const viewMode = useDevelopViewMode();
  // A software rasteriser makes the histogram readback disproportionately slow
  // (and CI runs on SwiftShader); screenshots opt back in.
  const histogramReadback =
    typeof window === 'undefined' || window.eeEnvironment?.screenshots === true;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mosaicRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const rendererRef = useRef<DevelopRenderer | null>(null);

  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [renderer, setRenderer] = useState<DevelopRenderer | null>(null);
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);

  // Auto and the picker turn camera gains into a temperature through the profile's ColorMatrix.
  const colorModel = useMemo(
    () => (loaded ? profileColorModel(profile, loaded.header.xyzToCamera) : undefined),
    [profile, loaded],
  );
  const [error, setError] = useState<string | undefined>(() =>
    typeof WebGL2RenderingContext === 'undefined' ? 'WebGL2 is not available' : undefined,
  );
  const [linearUnavailable, setLinearUnavailable] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const [mosaicVersion, setMosaicVersion] = useState(0);
  const [firstFrame, setFirstFrame] = useState(false);
  const [previewSource, setPreviewSource] = useState<'preview' | 'thumb' | 'none'>('preview');
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [draftRect, setDraftRect] = useState<Rect>();
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[]>([]);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragMoved = useRef(false);
  const [pickerPoint, setPickerPoint] = useState<{ x: number; y: number } | null>(null);
  const [splitting, setSplitting] = useState(false);
  const lastHistogramAt = useRef(0);
  const histogramKey = useRef('');

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = (): void =>
      setContainer({
        width: element.clientWidth || 900,
        height: element.clientHeight || 600,
      });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const sourceWidth = loaded?.header.width ?? image.width ?? 3000;
  const sourceHeight = loaded?.header.height ?? image.height ?? 2000;
  const sourceAspect = sourceWidth / sourceHeight;
  const cropOutput = params.crop
    ? cropOutputSize(params.crop, { width: sourceWidth, height: sourceHeight })
    : undefined;
  // While editing a crop or a retouch, the whole uncropped image is shown so
  // shapes and handles stay in source coordinates. Otherwise the developed
  // preview and the stage use the crop's aspect ratio.
  const imageAspect =
    session !== undefined || cropSession !== undefined
      ? sourceAspect
      : cropOutput !== undefined && cropOutput.height > 0
        ? cropOutput.width / cropOutput.height
        : sourceAspect;
  const editing = session !== undefined || cropSession !== undefined;
  const retouching = session !== undefined;
  const renderParams = useMemo(() => {
    let next = params;
    if (editing && next.crop !== undefined) {
      next = { ...next };
      delete next.crop;
    }
    // Retouch shapes are drawn and stored on the recorded picture, so a retouch session shows
    // it without the lens corrections that resample it; the finished picture maps them across.
    return retouching ? withoutLensGeometry(next) : next;
  }, [editing, retouching, params]);
  const cropping = cropSession !== undefined;
  const display = cropping
    ? cropFit(container, imageAspect).size
    : fitWithin(container, imageAspect);
  // Crop mode draws on the whole workspace: the rotated image is bigger than
  // the unrotated fit, and the frame is dragged around it.
  const stage = cropping ? { width: container.width, height: container.height } : display;

  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const requestedEdge =
    display.width > 0
      ? Math.min(
          MAX_EDGE,
          Math.max(
            MIN_EDGE,
            Math.ceil((Math.max(display.width, display.height) * dpr) / EDGE_BUCKET) * EDGE_BUCKET,
          ),
        )
      : MAX_EDGE;
  const bufferScale =
    display.width > 0
      ? Math.min(
          1,
          (cropping ? MAX_EDGE : requestedEdge) / (Math.max(stage.width, stage.height) * dpr),
        )
      : 1;
  // Drawing-buffer pixels per CSS pixel; the crop view maps through it.
  const bufferRatio = dpr * bufferScale;
  const bufferWidth = Math.max(1, Math.round(stage.width * bufferRatio));
  const bufferHeight = Math.max(1, Math.round(stage.height * bufferRatio));

  const cropView = useMemo((): CropViewTransform | undefined => {
    if (!cropSession || !loaded) return undefined;
    const layout = cropLayout(stage, cropSession.image);
    const geometry = cropGeometry(cropSession.crop, cropSession.image);
    const toBuffer = layout.scale * bufferRatio;
    const centre = {
      x: (layout.offset.x + cropSession.pivot.x * layout.scale) * bufferRatio,
      y: (layout.offset.y + cropSession.pivot.y * layout.scale) * bufferRatio,
    };
    return {
      crop: cropSession.crop,
      pivot: centre,
      // View units are pixels of the full oriented image; the texture may be a downscale of it.
      scale: toBuffer * (cropSession.image.width / loaded.header.width),
      frame: {
        x: centre.x - (geometry.width * toBuffer) / 2,
        y: centre.y - (geometry.height * toBuffer) / 2,
        w: geometry.width * toBuffer,
        h: geometry.height * toBuffer,
      },
      dim: CROP_DIM,
      outside: CROP_OUTSIDE,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cropSession?.crop,
    cropSession?.pivot,
    cropSession?.image,
    loaded,
    stage.width,
    stage.height,
    bufferRatio,
  ]);

  useEffect(() => {
    store.loadPhotoProfile(photo.id, {
      CameraProfile: params.CameraProfile,
      LookName: params.LookName,
      LookUUID: params.LookUUID,
    });
    // `params` itself changes with every slider; only the profile choice matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, photo.id, params.CameraProfile, params.LookName, params.LookUUID]);

  // Create the WebGL renderer once per canvas; the image is uploaded separately.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof WebGL2RenderingContext === 'undefined') return;
    let created: DevelopRenderer;
    try {
      created = createDevelopRenderer(canvas, {
        grainSeed: grainSeedFromId(photo.id),
        onNeighbourhoodUnavailable: () =>
          store.notifyOnce(
            'develop-float',
            'info',
            'This GPU cannot draw Texture, Clarity, Dehaze, sharpening or noise reduction (no float render targets), so the preview skips them. Exports still apply them.',
          ),
        onContextLost: () => {
          setContextLost(true);
          setFirstFrame(false);
        },
      });
    } catch (cause) {
      queueMicrotask(() => setError(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    rendererRef.current = created;
    setRenderer(created);
    const onRestored = (): void => setContextLost(false);
    canvas.addEventListener('webglcontextrestored', onRestored);
    return () => {
      canvas.removeEventListener('webglcontextrestored', onRestored);
      created.dispose();
      rendererRef.current = null;
      setRenderer(null);
    };
  }, [photo.id, store]);

  // Keep the drawing buffer exactly the size the image is fitted to (capped).
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const mosaic = mosaicRef.current;
    for (const element of [canvas, mosaic]) {
      if (!element) continue;
      if (element.width !== bufferWidth) element.width = bufferWidth;
      if (element.height !== bufferHeight) element.height = bufferHeight;
    }
  }, [bufferWidth, bufferHeight]);

  // Load the linear image at the size the canvas needs.
  useEffect(() => {
    if (container.width <= 0) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        // A restarted jobs process answers 503 for a moment; retry briefly.
        let response: Response | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
          response = await fetch(appUrl.linear(photo.id, requestedEdge), {
            signal: controller.signal,
          });
          if (response.status !== 503 || attempt === 3) break;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 250 * 2 ** attempt);
            controller.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new DOMException('aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        }
        if (!response) throw new Error('no response');
        if (!response.ok) {
          // Mock mode and non-raw formats without a linear source still show the
          // cached JPEG; the develop controls just do not affect it.
          if (response.status === 415 || response.status === 501) {
            if (!cancelled) {
              setLinearUnavailable(true);
              setError(undefined);
            }
            return;
          }
          throw new Error(`linear image request failed (${response.status})`);
        }
        const raw = response.headers.get(LINEAR_IMAGE_HEADER);
        if (!raw) throw new Error('linear image header missing');
        const header = JSON.parse(raw) as LinearImageHeader;
        const data = await response.arrayBuffer();
        if (!cancelled) {
          setLoaded({ header, data });
          // The Lens Corrections panel reads the lens facts of the image on screen.
          store.setPhotoLens(photo.id, header.lens, header);
          setLinearUnavailable(false);
          setError(undefined);
        }
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [photo.id, requestedEdge, container.width, store]);

  // Upload the image after it arrives, after a context restore, and when the
  // photo changes. Rendering is separate so slider changes only draw.
  useEffect(() => {
    if (!renderer || !loaded || contextLost || profilePending) return;
    try {
      renderer.setImage(loaded.header, loaded.data);
      renderer.setProfile(profile);
      renderer.render(renderParams);
    } catch (cause) {
      queueMicrotask(() => setError(cause instanceof Error ? cause.message : String(cause)));
    }
    // Rendering on the next frame keeps the slider smooth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, loaded, contextLost, profilePending]);

  useEffect(() => {
    if (!renderer || !loaded || contextLost || profilePending) return;
    // One draw per animation frame however fast pointer events arrive; the
    // view transform is a uniform change, not a CPU resample.
    const frame = requestAnimationFrame(() => {
      try {
        renderer.setProfile(profile);
        const options = {
          clipping: { shadows: viewMode.clipShadows, highlights: viewMode.clipHighlights },
        };
        const clipping = viewMode.clipShadows || viewMode.clipHighlights;
        const before = beforeParams(renderParams);
        const draw = (drawOptions: typeof options | undefined): void => {
          if (cropView) renderer.renderView(renderParams, cropView);
          else if (viewMode.beforeAfter === 'split')
            renderer.renderSplit(renderParams, before, viewMode.split, drawOptions);
          else if (viewMode.beforeAfter === 'before') renderer.render(before, drawOptions);
          else renderer.render(renderParams, drawOptions);
        };
        draw(options);
        setRenderVersion((version) => version + 1);
        setFirstFrame(true);
        // The histogram is a small GPU downsample of this frame, throttled so
        // the readback never becomes part of the slider loop. Crop mode draws
        // overlays around the frame, so it keeps the committed crop's histogram.
        if (!cropView && (!renderer.softwareRendering || histogramReadback)) {
          const now = typeof performance === 'undefined' ? Date.now() : performance.now();
          const key = `${photo.id}|${viewMode.beforeAfter}`;
          if (histogramKey.current !== key || now - lastHistogramAt.current >= 200) {
            histogramKey.current = key;
            lastHistogramAt.current = now;
            // The clipping overlay is a view aid: measure the developed frame
            // without it, then draw the overlay back on.
            if (clipping) draw(undefined);
            try {
              setHistogram(photo.id, renderer.readHistogram());
            } finally {
              if (clipping) draw(options);
            }
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => cancelAnimationFrame(frame);
    // The buffer size is a dependency: resizing a canvas clears it.
  }, [
    renderer,
    loaded,
    contextLost,
    renderParams,
    cropView,
    bufferWidth,
    bufferHeight,
    photo.id,
    viewMode.beforeAfter,
    viewMode.split,
    viewMode.clipShadows,
    viewMode.clipHighlights,
    histogramReadback,
    profile,
    profilePending,
  ]);

  // One-shot Auto commands from the panel: measure a small render (tone) or the
  // camera pixels (white balance), then write the result as normal slider values.
  useEffect(() => {
    const request = viewMode.request;
    if (!request || !renderer || !loaded || contextLost) return;
    try {
      if (request.action === 'auto-wb') {
        const result = autoWhiteBalance(loaded.header, loaded.data, renderParams.crop, colorModel);
        store.setWhiteBalance(Math.round(result.temperature), Math.round(result.tint));
      } else {
        const source = { width: loaded.header.width, height: loaded.header.height };
        const logical = renderParams.crop
          ? cropOutputSize(renderParams.crop, source)
          : { width: source.width, height: source.height };
        const scale = Math.min(1, 1024 / Math.max(1, logical.width, logical.height));
        const size = {
          width: Math.max(1, Math.round(logical.width * scale)),
          height: Math.max(1, Math.round(logical.height * scale)),
        };
        const rgba = renderer.renderToRGBA(autoToneBasis(renderParams), size);
        store.applyAutoTone(predictAutoTone(rgba, size.width, size.height));
      }
    } catch (cause) {
      store.notify(
        'error',
        `Auto failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      clearDevelopAction(request.sequence);
    }
  }, [viewMode.request, renderer, loaded, contextLost, renderParams, store, colorModel]);

  const pickerFrom = (event: React.MouseEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp01((event.clientY - rect.top) / Math.max(1, rect.height)),
    };
  };

  const pickWhiteBalance = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!loaded) return;
    const point = pickerFrom(event);
    const source = { width: loaded.header.width, height: loaded.header.height };
    const crop = renderParams.crop;
    const imagePoint = crop
      ? (() => {
          const output = cropOutputSize(crop, source);
          return croppedToSourcePixels(crop, source, {
            x: point.x * output.width,
            y: point.y * output.height,
          });
        })()
      : { x: point.x * source.width, y: point.y * source.height };
    const rect = event.currentTarget.getBoundingClientRect();
    // About five display pixels across, in source pixels.
    const radius = Math.max(2, Math.round((source.width / Math.max(1, rect.width)) * 5));
    try {
      const result = whiteBalanceFromPatch(
        loaded.header,
        loaded.data,
        imagePoint,
        radius,
        colorModel,
      );
      store.setWhiteBalance(Math.round(result.temperature), Math.round(result.tint));
      setWbPicker(false);
      setPickerPoint(null);
    } catch (cause) {
      store.notify(
        'error',
        `White balance picker: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  // The committed retouch version is the default view; while editing, the
  // pending shapes and enabled faces replace it.
  const committedMosaic = useMemo(() => {
    const version = topRetouchVersion(image);
    return version?.ops.find((op) => op.type === 'mosaic');
  }, [image]);
  const mosaicShapes = useMemo(
    () =>
      session
        ? [
            ...session.shapes,
            ...session.faces
              .filter((face) => face.enabled)
              .map((face) => faceStoredShape(face.box, session.facePadding, lensContext)),
          ]
        : (committedMosaic?.shapes ?? []),
    [session, committedMosaic, lensContext],
  );
  const blockSizeRel = session?.blockSizeRel ?? committedMosaic?.blockSizeRel ?? 0.012;

  // Live mosaic preview: render at the view size, mosaic the pixels on the CPU,
  // and paint them over the canvas. Runs in the normal view too, so a committed
  // retouch version is what the user sees (and what Next & send exports).
  useEffect(() => {
    const mosaic = mosaicRef.current;
    if (!mosaic) return;
    const context = mosaic.getContext('2d');
    if (!context) return;
    if (cropping || mosaicShapes.length === 0 || !renderer || !loaded || contextLost) {
      context.clearRect(0, 0, mosaic.width, mosaic.height);
      return;
    }
    // Shapes are stored on the recorded picture; a lens correction moves them with its pixels.
    const op = {
      type: 'mosaic' as const,
      shapes: correctedShapes(mosaicShapes, loaded.header, renderParams),
      blockSizeRel,
    };
    const frame = requestAnimationFrame(() => {
      try {
        let rgba: Uint8Array;
        if (renderParams.crop !== undefined) {
          // Mosaic in source space, then crop/rotate, matching the export path.
          const source = { width: loaded.header.width, height: loaded.header.height };
          const uncropped = { ...renderParams };
          delete uncropped.crop;
          const sourceRgba = renderer.renderToRGBA(uncropped, source);
          applyMosaic(sourceRgba, source.width, source.height, op, { inPlace: true });
          rgba = cropDevelopedRgba(sourceRgba, source, renderParams.crop, {
            width: mosaic.width,
            height: mosaic.height,
          });
        } else {
          rgba = renderer.renderToRGBA(renderParams, {
            width: mosaic.width,
            height: mosaic.height,
          });
          applyMosaic(rgba, mosaic.width, mosaic.height, op, { inPlace: true });
        }
        context.putImageData(
          new ImageData(new Uint8ClampedArray(rgba), mosaic.width, mosaic.height),
          0,
          0,
        );
        setMosaicVersion((version) => version + 1);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    mosaicShapes,
    blockSizeRel,
    renderer,
    loaded,
    contextLost,
    renderParams,
    cropping,
    bufferWidth,
    bufferHeight,
  ]);

  const updateDraft = (event: React.PointerEvent): void => {
    const surface = overlayRef.current;
    if (!surface) return;
    const point = normalizedPoint(event, surface);
    if (!dragStart.current) return;
    dragMoved.current = true;
    if (session?.tool === 'lasso') {
      setDraftPoints((current) => {
        const last = current[current.length - 1];
        if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.004) return current;
        return [...current, point];
      });
    } else if (session?.tool === 'rect' || session?.tool === 'faces') {
      setDraftRect(rectFromPoints(dragStart.current, point));
    }
  };

  const finishDrag = async (event: React.PointerEvent): Promise<void> => {
    if (!session || !dragStart.current) return;
    const surface = overlayRef.current;
    if (!surface) return;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    const start = dragStart.current;
    const end = normalizedPoint(event, surface);
    dragStart.current = null;
    if (session.tool === 'wand') {
      setDraftRect(undefined);
      if (!dragMoved.current || Math.hypot(end.x - start.x, end.y - start.y) < 0.02) {
        await runMagicWand(end);
      }
      return;
    }
    if (session.tool === 'lasso') {
      const points = [...draftPoints, end];
      setDraftPoints([]);
      if (points.length >= 3) {
        const simplified = simplifyPolygon(points, 0.003);
        if (simplified.length >= 3) store.addRetouchShape({ type: 'polygon', points: simplified });
      }
      return;
    }
    const rect = rectFromPoints(start, end);
    setDraftRect(undefined);
    if (rect.w < 0.01 || rect.h < 0.01) return;
    if (session.tool === 'faces') await detectFaces(rect);
    else store.addRetouchShape(rect);
  };

  const runMagicWand = async (point: { x: number; y: number }): Promise<void> => {
    const mosaic = mosaicRef.current;
    if (!session || !renderer || !mosaic) return;
    try {
      const rgba = renderer.renderToRGBA(renderParams, {
        width: mosaic.width,
        height: mosaic.height,
      });
      const result = magicWand(
        rgba,
        mosaic.width,
        mosaic.height,
        {
          x: point.x * mosaic.width,
          y: point.y * mosaic.height,
        },
        { tolerance: session.tolerance },
      );
      for (const shape of result.shapes) store.addRetouchShape(shape);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const detectFaces = async (region: Rect): Promise<void> => {
    if (!session) return;
    store.setRetouchBusy(true);
    try {
      // The region is drawn on the recorded picture; the detector looks at the camera's preview.
      const detections = await ee.invoke('retouch:detectFaces', {
        photoId: photo.id,
        region: detectionRegion(region, lensContext),
      });
      if (detections.length === 0) {
        store.notify('info', 'No faces found in that area');
      }
      const detected: RetouchFace[] = detections.map((face) => ({
        box: face.box,
        score: face.score,
        enabled: true,
      }));
      store.setRetouchFaces(detected);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      store.notify('error', `Face detection failed: ${message}`);
    } finally {
      store.setRetouchBusy(false);
    }
  };

  const onPointerDown = (event: React.PointerEvent): void => {
    if (!session) return;
    if (event.button !== 0) return;
    const surface = overlayRef.current;
    if (!surface) return;
    event.preventDefault();
    dragStart.current = normalizedPoint(event, surface);
    dragMoved.current = false;
    surface.setPointerCapture(event.pointerId);
    if (session.tool === 'lasso') setDraftPoints([dragStart.current]);
  };
  const onPointerMove = (event: React.PointerEvent): void => {
    if (!dragStart.current) return;
    updateDraft(event);
  };
  const onPointerUp = (event: React.PointerEvent): void => {
    void finishDrag(event);
  };

  const rectsInPreview = session && draftRect ? [draftRect] : [];

  return (
    <div className={styles.canvasWrap} data-testid="photo-canvas" ref={containerRef}>
      <div
        className={styles.stage}
        style={{
          width: `${Math.round(stage.width)}px`,
          height: `${Math.round(stage.height)}px`,
        }}
        data-photo-id={photo.id}
        data-mode={cropSession ? 'crop' : session ? 'retouch' : 'develop'}
      >
        {/*
         * The cached image is of the edited photo (cropped, or a placeholder while a
         * mosaic is still being drawn). While a crop or retouch is edited the stage is
         * the whole uncropped image, so it would be stretched to the wrong shape;
         * the GL canvas draws the uncropped image on its own.
         */}
        {previewSource !== 'none' && !editing && (
          <img
            className={styles.image}
            src={
              previewSource === 'thumb'
                ? appUrl.thumb(photo.id, image.previewRevision)
                : appUrl.preview(photo.id, image.previewRevision)
            }
            alt={photo.fileName}
            draggable={false}
            data-testid="preview-image"
            data-visible={!firstFrame && !contextLost ? 'true' : 'false'}
            style={{ opacity: firstFrame || contextLost ? 0 : 1 }}
            onLoad={() => setPreviewLoaded(true)}
            onError={() => {
              setPreviewLoaded(false);
              setPreviewSource((source) => (source === 'preview' ? 'thumb' : 'none'));
            }}
          />
        )}
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          data-visible={firstFrame && !contextLost ? 'true' : 'false'}
          style={{ opacity: firstFrame && !contextLost ? 1 : 0 }}
          data-testid="develop-canvas"
          data-ready={loaded !== null && !contextLost ? 'true' : 'false'}
          data-render-version={renderVersion}
          aria-label={`Developed preview of ${photo.fileName}`}
        />
        <canvas
          ref={mosaicRef}
          className={styles.mosaic}
          aria-hidden
          data-testid="mosaic-canvas"
          data-mosaic-version={mosaicVersion}
        />
        {!editing && loaded && viewMode.wbPicker && (
          <div
            className={styles.pickerLayer}
            data-testid="wb-picker-layer"
            onPointerMove={(event) => setPickerPoint(pickerFrom(event))}
            onPointerLeave={() => setPickerPoint(null)}
            onClick={pickWhiteBalance}
          >
            <span className={styles.pickerHint}>Click a neutral area · Esc cancels</span>
          </div>
        )}
        {!editing && viewMode.wbPicker && pickerPoint && (
          <div
            className={styles.loupe}
            data-testid="wb-loupe"
            style={{
              left: `${Math.min(stage.width - 116, Math.max(8, pickerPoint.x * stage.width + 18))}px`,
              top: `${Math.min(stage.height - 116, Math.max(8, pickerPoint.y * stage.height + 18))}px`,
              backgroundImage: `url("${appUrl.preview(photo.id, image.previewRevision)}")`,
              backgroundSize: `${stage.width * 4}px ${stage.height * 4}px`,
              backgroundPosition: `${-(pickerPoint.x * stage.width * 4 - 54)}px ${-(pickerPoint.y * stage.height * 4 - 54)}px`,
            }}
          />
        )}
        {!editing && viewMode.beforeAfter === 'split' && (
          <>
            <span className={`${styles.splitLabel} ${styles.splitLabelLeft}`}>Before</span>
            <span
              className={`${styles.splitLabel} ${styles.splitLabelRight}`}
              style={{ left: `calc(${viewMode.split * 100}% + 8px)` }}
            >
              After
            </span>
            <div
              className={styles.splitDivider}
              style={{ left: `${viewMode.split * 100}%` }}
              data-testid="split-divider"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={Math.round(viewMode.split * 100)}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setSplitting(true);
              }}
              onPointerMove={(event) => {
                if (!splitting) return;
                const stage = event.currentTarget.parentElement;
                if (!stage) return;
                const rect = stage.getBoundingClientRect();
                setSplit((event.clientX - rect.left) / Math.max(1, rect.width));
              }}
              onPointerUp={(event) => {
                setSplitting(false);
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => setSplitting(false)}
            />
          </>
        )}
        {committedMosaic && !session && (
          <div className={styles.versionBadge} data-testid="retouch-version-indicator">
            <PenIcon size={10} /> Retouch version
          </div>
        )}
        {cropSession && <CropOverlay session={cropSession} stage={stage} />}
        {cropSession && <CropToolbar session={cropSession} />}
        {session && (
          <svg
            ref={overlayRef}
            className={styles.overlay}
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            data-testid="retouch-overlay"
          >
            {[...session.shapes, ...rectsInPreview].map((shape, index) => (
              <path key={`shape-${index}`} d={shapePath(shape)} className={styles.shape} />
            ))}
            {draftPoints.length > 1 && (
              <polyline
                className={styles.shape}
                points={draftPoints.map((point) => `${point.x},${point.y}`).join(' ')}
              />
            )}
            {session.faces.map((face, index) => {
              const shape = faceStoredShape(face.box, session.facePadding, lensContext);
              const bounds = shapeBox(shape);
              return (
                <path
                  key={`face-${index}`}
                  d={shapePath(shape)}
                  className={`${styles.face} ${face.enabled ? styles.faceOn : styles.faceOff}`}
                  data-face-box={`${bounds.x},${bounds.y},${bounds.w},${bounds.h}`}
                  data-face-index={index}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    store.toggleRetouchFace(index);
                  }}
                >
                  <title>
                    Face {index + 1}
                    {face.score === undefined ? '' : ` · ${(face.score * 100).toFixed(0)}%`}
                    {face.enabled ? ' · selected' : ' · off'}
                  </title>
                </path>
              );
            })}
          </svg>
        )}
        {contextLost && <div className={styles.notice}>Restoring the graphics context…</div>}
        {!firstFrame && !previewLoaded && !error && (
          <div className={styles.notice}>
            {linearUnavailable ? 'Preview unavailable' : 'Loading…'}
          </div>
        )}
        {error && <div className={`${styles.notice} ${styles.error}`}>{error}</div>}
        <Toolbar />
      </div>
    </div>
  );
}

/** Mount point for the develop renderer and the retouch overlay. */
export function PhotoCanvas({ photo }: { photo: Photo | undefined }) {
  if (!photo) {
    return (
      <div className={styles.empty} data-testid="photo-canvas">
        No photos yet. Start an ingest to fill the film strip.
      </div>
    );
  }
  return <CanvasForPhoto key={photo.id} photo={photo} />;
}
