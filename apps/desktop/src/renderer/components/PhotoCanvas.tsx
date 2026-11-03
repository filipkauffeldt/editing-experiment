import {
  LINEAR_IMAGE_HEADER,
  appUrl,
  mapMosaicShapes,
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
import { polygonBounds, shapeBounds, simplifyPolygon } from '@ee/retouch';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ee } from '../ee';
import {
  hasPendingRetouch,
  namesProfile,
  paramsForPhoto,
  topRetouchVersion,
  type FaceSearchArea,
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
import {
  blockSizePxRange,
  blockSizePxToRel,
  blockSizeRelToPx,
  photoLongEdge,
} from '../retouch-block-size';
import {
  altFlipsMode,
  areaIndexAt,
  areaShape,
  countAreas,
  opFromAreas,
  opHasAddedArea,
  type RetouchMode,
} from '../retouch-areas';
import { detectionRegion, facesInLasso } from '../retouch-geometry';
import { renderMosaicPreview } from '../retouch-preview';
import { useAppState, useAppStore } from '../store-context';
import { CropOverlay } from './CropOverlay';
import { CropToolbar } from './CropToolbar';
import { CheckIcon, EyeIcon, PenIcon } from './icons';
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

/** A press that moves less than this (of the picture's size) is a click, not a drawing. */
const CLICK_DISTANCE = 0.006;

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
  faces: 'Detect faces',
};

const MODE_LABELS: Record<RetouchMode, string> = {
  add: 'Add',
  subtract: 'Subtract',
};

const FACE_AREA_LABELS: Record<FaceSearchArea, string> = {
  rect: 'Rectangle',
  lasso: 'Lasso',
};

function Toolbar({ photo }: { photo: Photo }) {
  const store = useAppStore();
  const state = useAppState();
  const session = state.retouch;
  if (!session) return null;
  const counts = countAreas(session.areas);
  const unsaved = hasPendingRetouch(session);
  return (
    <div className={styles.toolbar} data-testid="retouch-toolbar">
      <div className={styles.tools}>
        {(Object.keys(TOOL_LABELS) as RetouchTool[]).map((tool) => (
          <button
            key={tool}
            type="button"
            className={`${styles.tool} ${session.tool === tool ? styles.toolActive : ''}`}
            onClick={() => store.setRetouchTool(tool)}
            aria-pressed={session.tool === tool}
            data-tool={tool}
          >
            {TOOL_LABELS[tool]}
          </button>
        ))}
      </div>
      {/* The way out comes right after the tools, so a narrow window wraps the sliders, not it. */}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => store.undoRetouchShape()}
          disabled={session.undo.length === 0}
          title="Undo the last change to the areas (Ctrl/⌘+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void store.deleteRetouchVersion()}
          title="Remove the saved retouch version of this photo"
        >
          Delete version
        </button>
        {unsaved && (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => store.exitRetouch()}
            title="Leave retouch mode and throw away the changes you have not saved"
            data-testid="discard-retouch"
          >
            Discard changes
          </button>
        )}
        <button
          type="button"
          className={styles.commit}
          onClick={() => void store.commitRetouch()}
          disabled={session.busy}
          data-testid="commit-retouch"
        >
          <PenIcon size={11} /> {session.busy ? 'Saving…' : 'Mosaic'}
        </button>
        <button
          type="button"
          className={styles.done}
          onClick={() => void store.requestExitRetouch()}
          title={
            unsaved
              ? 'Save the mosaic and leave retouch mode (Esc)'
              : 'Leave retouch mode, keeping what is saved (Esc)'
          }
          data-testid="done-retouch"
        >
          <CheckIcon size={11} /> Done
        </button>
      </div>
      <div className={styles.tools} role="group" aria-label="Mode" data-testid="retouch-mode">
        {(Object.keys(MODE_LABELS) as RetouchMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`${styles.tool} ${session.mode === mode ? styles.toolActive : ''}`}
            onClick={() => store.setRetouchMode(mode)}
            aria-pressed={session.mode === mode}
            title={
              mode === 'add'
                ? 'New shapes and faces add mosaic'
                : 'New shapes and faces take mosaic away (hold Alt while drawing to flip the mode)'
            }
            data-mode={mode}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
      </div>
      {session.tool === 'faces' && (
        <div className={styles.tools} role="group" aria-label="Search area">
          {(Object.keys(FACE_AREA_LABELS) as FaceSearchArea[]).map((area) => (
            <button
              key={area}
              type="button"
              className={`${styles.tool} ${session.faceArea === area ? styles.toolActive : ''}`}
              onClick={() => store.setRetouchFaceArea(area)}
              aria-pressed={session.faceArea === area}
              data-face-area={area}
            >
              {FACE_AREA_LABELS[area]}
            </button>
          ))}
        </div>
      )}
      <BlockSizeControl photo={photo} />
      {(session.tool === 'faces' || counts.faces.total > 0) && (
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
      {(counts.faces.total > 0 || counts.drawn.total > 0) && (
        <div className={styles.faceHint} data-testid="area-counts">
          <EyeIcon size={10} />
          {counts.faces.total > 0 && (
            <span data-testid="face-count">
              {' '}
              {counts.faces.on}/{counts.faces.total} faces on
            </span>
          )}
          {counts.drawn.total > 0 && (
            <span data-testid="drawn-count">
              {' '}
              {counts.drawn.on}/{counts.drawn.total} areas on
            </span>
          )}
        </div>
      )}
      <div className={styles.toolHint}>
        {session.tool === 'faces'
          ? session.faceArea === 'lasso'
            ? 'Draw a loose outline around the faces.'
            : 'Drag a rough area around the faces.'
          : session.tool === 'lasso'
            ? 'Draw a freehand outline.'
            : 'Drag a rectangle around what to pixelate.'}{' '}
        Click an area to switch it on or off. Esc saves and leaves.
      </div>
    </div>
  );
}

/** Block size in pixels of the full-resolution photo; percent only while its size is unknown. */
function BlockSizeControl({ photo }: { photo: Photo }) {
  const store = useAppStore();
  const session = useAppState().retouch;
  if (!session) return null;
  const longEdge = photoLongEdge(photo);
  if (longEdge === undefined) {
    return (
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
    );
  }
  const px = blockSizeRelToPx(session.blockSizeRel, longEdge);
  const range = blockSizePxRange(px);
  return (
    <label
      className={styles.control}
      title="Block edge in pixels of the full-resolution photo. Small selections get larger blocks, so a face stays unrecognisable."
    >
      <span data-testid="block-size-label">Block size {px} px</span>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={px}
        aria-label="Mosaic block size"
        onChange={(event) =>
          store.setRetouchBlockSize(blockSizePxToRel(Number(event.target.value), longEdge))
        }
      />
    </label>
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
  const dragPointer = useRef<number | null>(null);
  const drawMode = useRef<RetouchMode>('add');
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

  // The committed retouch version is the default view; while editing, the session's areas
  // (shapes and faces, added, subtracted or off) replace it.
  const committedMosaic = useMemo(() => {
    const version = topRetouchVersion(image);
    return version?.ops.find((op) => op.type === 'mosaic');
  }, [image]);
  const mosaicOp = useMemo(
    () =>
      session
        ? opFromAreas(session.areas, session.blockSizeRel, session.facePadding, lensContext)
        : committedMosaic,
    [session, committedMosaic, lensContext],
  );

  // Live mosaic preview: render at the view size, mosaic the pixels on the CPU,
  // and paint them over the canvas. Runs in the normal view too, so a committed
  // retouch version is what the user sees (and what Next & send exports).
  useEffect(() => {
    const mosaic = mosaicRef.current;
    if (!mosaic) return;
    const context = mosaic.getContext('2d');
    if (!context) return;
    if (cropping || !mosaicOp || !opHasAddedArea(mosaicOp) || !renderer || !loaded || contextLost) {
      context.clearRect(0, 0, mosaic.width, mosaic.height);
      return;
    }
    // Shapes are stored on the recorded picture; a lens correction moves them with its pixels.
    const op = mapMosaicShapes(mosaicOp, (shapes) =>
      correctedShapes(shapes, loaded.header, renderParams),
    );
    const frame = requestAnimationFrame(() => {
      try {
        const rgba = renderMosaicPreview({
          op,
          params: renderParams,
          source: { width: loaded.header.width, height: loaded.header.height },
          output: { width: mosaic.width, height: mosaic.height },
          render: (params, size) => renderer.renderToRGBA(params, size),
        });
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
  }, [mosaicOp, renderer, loaded, contextLost, renderParams, cropping, bufferWidth, bufferHeight]);

  // Detect faces can take its search area as a lasso too; both lassos are drawn the same way.
  const drawsLasso =
    session?.tool === 'lasso' || (session?.tool === 'faces' && session.faceArea === 'lasso');

  const updateDraft = (event: React.PointerEvent): void => {
    const surface = overlayRef.current;
    if (!surface) return;
    const point = normalizedPoint(event, surface);
    if (!dragStart.current) return;
    dragMoved.current = true;
    if (drawsLasso) {
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
    dragPointer.current = null;
    const mode = drawMode.current;
    // A click, not a drag, switches the topmost area under it on or off, wherever the tool is.
    const clicked =
      Math.hypot(end.x - start.x, end.y - start.y) < CLICK_DISTANCE &&
      (!drawsLasso || draftPoints.length < 3 || !dragMoved.current);
    if (clicked) {
      setDraftPoints([]);
      setDraftRect(undefined);
      const index = areaIndexAt(session.areas, end, session.facePadding, lensContext);
      if (index >= 0) store.toggleRetouchArea(index);
      return;
    }
    if (drawsLasso) {
      const points = [...draftPoints, end];
      setDraftPoints([]);
      if (points.length >= 3) {
        const simplified = simplifyPolygon(points, 0.003);
        if (simplified.length < 3) return;
        if (session.tool === 'faces') {
          // Search the lasso's bounding box; only faces centred inside the outline are kept.
          const bounds = polygonBounds(simplified);
          if (bounds.w >= 0.01 && bounds.h >= 0.01) await detectFaces(bounds, mode, simplified);
        } else {
          store.addRetouchShape({ type: 'polygon', points: simplified }, mode);
        }
      }
      return;
    }
    const rect = rectFromPoints(start, end);
    setDraftRect(undefined);
    if (rect.w < 0.01 || rect.h < 0.01) return;
    if (session.tool === 'faces') await detectFaces(rect, mode);
    else store.addRetouchShape(rect, mode);
  };

  const detectFaces = async (
    region: Rect,
    mode: RetouchMode,
    lasso?: readonly { x: number; y: number }[],
  ): Promise<void> => {
    if (!session) return;
    store.setRetouchBusy(true);
    try {
      // The region is drawn on the recorded picture; the detector looks at the camera's preview.
      const detections = await ee.invoke('retouch:detectFaces', {
        photoId: photo.id,
        region: detectionRegion(region, lensContext),
      });
      // Retouch was left (or moved to another photo) while the detector ran: drop the result.
      if (store.getState().retouch?.photoId !== photo.id) return;
      const inside = lasso ? facesInLasso(detections, lasso, lensContext) : detections;
      if (inside.length === 0) {
        store.notify('info', 'No faces found in that area');
      }
      store.addRetouchFaces(
        inside.map((face) => ({ box: face.box, score: face.score })),
        mode,
      );
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
    dragPointer.current = event.pointerId;
    // Alt flips Add and Subtract for this one gesture; AltGr never does.
    drawMode.current = altFlipsMode(event)
      ? session.mode === 'add'
        ? 'subtract'
        : 'add'
      : session.mode;
    dragStart.current = normalizedPoint(event, surface);
    dragMoved.current = false;
    surface.setPointerCapture(event.pointerId);
    if (drawsLasso) setDraftPoints([dragStart.current]);
  };
  const onPointerMove = (event: React.PointerEvent): void => {
    if (!dragStart.current) return;
    updateDraft(event);
  };
  const onPointerUp = (event: React.PointerEvent): void => {
    void finishDrag(event);
  };

  // Escape while a shape is being drawn drops that shape; the keyboard handler only sees the
  // key when nothing is mid-draw. Capture phase, so it runs before the global shortcuts.
  useEffect(() => {
    if (!retouching) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !dragStart.current) return;
      event.preventDefault();
      event.stopPropagation();
      const surface = overlayRef.current;
      const pointerId = dragPointer.current;
      if (surface && pointerId !== null && surface.hasPointerCapture(pointerId)) {
        surface.releasePointerCapture(pointerId);
      }
      dragStart.current = null;
      dragPointer.current = null;
      setDraftRect(undefined);
      setDraftPoints([]);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [retouching]);

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
            {session.areas.map((area, index) => {
              const shape = areaShape(area, session.facePadding, lensContext);
              const bounds = shapeBox(shape);
              return (
                <path
                  key={`area-${index}`}
                  d={shapePath(shape)}
                  className={`${styles.area} ${area.enabled ? styles.areaOn : styles.areaOff} ${
                    area.mode === 'subtract' ? styles.areaSubtract : ''
                  } ${area.kind === 'face' ? styles.areaFace : ''}`}
                  data-area-index={index}
                  data-area-kind={area.kind}
                  data-area-mode={area.mode}
                  data-area-enabled={area.enabled ? 'true' : 'false'}
                  {...(area.kind === 'face'
                    ? {
                        'data-face-index': index,
                        'data-face-box': `${bounds.x},${bounds.y},${bounds.w},${bounds.h}`,
                      }
                    : {})}
                >
                  <title>
                    {area.kind === 'face'
                      ? `Face${area.face?.score === undefined ? '' : ` · ${(area.face.score * 100).toFixed(0)}%`}`
                      : area.kind === 'lasso'
                        ? 'Lasso'
                        : 'Rectangle'}
                    {area.mode === 'subtract' ? ' · subtract' : ''}
                    {area.enabled ? ' · on' : ' · off'}
                  </title>
                </path>
              );
            })}
            {rectsInPreview.map((shape, index) => (
              <path
                key={`draft-${index}`}
                d={shapePath(shape)}
                className={`${styles.shape} ${drawMode.current === 'subtract' ? styles.areaSubtract : ''}`}
              />
            ))}
            {draftPoints.length > 1 && (
              <polyline
                className={`${styles.shape} ${drawMode.current === 'subtract' ? styles.areaSubtract : ''}`}
                points={draftPoints.map((point) => `${point.x},${point.y}`).join(' ')}
              />
            )}
          </svg>
        )}
        {contextLost && <div className={styles.notice}>Restoring the graphics context…</div>}
        {!firstFrame && !previewLoaded && !error && (
          <div className={styles.notice}>
            {linearUnavailable ? 'Preview unavailable' : 'Loading…'}
          </div>
        )}
        {error && <div className={`${styles.notice} ${styles.error}`}>{error}</div>}
      </div>
      {/* Outside the stage: the stage is only as wide as the photo, a portrait one would clip it. */}
      <Toolbar photo={photo} />
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
