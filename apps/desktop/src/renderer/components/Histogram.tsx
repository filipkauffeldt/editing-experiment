import type { Photo } from '@ee/contracts';
import type { Histogram as HistogramData } from '@ee/develop-gl';
import { useEffect, useRef, useState } from 'react';
import {
  toggleClipHighlights,
  toggleClipShadows,
  useDevelopViewMode,
  useHistogram,
} from '../develop-view';
import styles from './Histogram.module.css';

const HEIGHT = 78;

function css(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function drawChannel(
  context: CanvasRenderingContext2D,
  bins: Uint32Array,
  peak: number,
  width: number,
  height: number,
  colour: string,
  filled: boolean,
): void {
  const count = bins.length;
  const y = (value: number): number => height - (value / Math.max(1, peak)) * height;
  context.beginPath();
  context.moveTo(0, height);
  for (let i = 0; i < count; i++) {
    context.lineTo((i / Math.max(1, count - 1)) * width, y(bins[i] ?? 0));
  }
  context.lineTo(width, height);
  if (filled) {
    context.closePath();
    context.fillStyle = colour;
    context.fill();
    return;
  }
  context.strokeStyle = colour;
  context.lineWidth = 1;
  context.stroke();
}

function draw(canvas: HTMLCanvasElement, histogram: HistogramData | undefined): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 260;
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(HEIGHT * ratio)) canvas.height = Math.round(HEIGHT * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, HEIGHT);
  if (!histogram) return;

  let peak = 0;
  for (const bins of [histogram.luminance, histogram.red, histogram.green, histogram.blue]) {
    for (const value of bins) if (value > peak) peak = value;
  }
  if (peak === 0) return;
  const luma = css('--hist-luma', '#b9b9bb');
  context.globalAlpha = 0.55;
  drawChannel(context, histogram.luminance, peak, width, HEIGHT, luma, true);
  context.globalAlpha = 0.9;
  drawChannel(context, histogram.red, peak, width, HEIGHT, css('--hist-red', '#b08a8a'), false);
  drawChannel(context, histogram.green, peak, width, HEIGHT, css('--hist-green', '#8fae8f'), false);
  drawChannel(context, histogram.blue, peak, width, HEIGHT, css('--hist-blue', '#8a96b8'), false);
  context.globalAlpha = 1;
}

function shutterLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds >= 1) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

function exifLine(photo: Photo | undefined): string | undefined {
  if (!photo) return undefined;
  const camera = photo.camera;
  const parts = [
    camera?.iso === undefined ? undefined : `ISO ${Math.round(camera.iso)}`,
    camera?.focalLength === undefined ? undefined : `${Math.round(camera.focalLength)}mm`,
    camera?.aperture === undefined ? undefined : `f/${camera.aperture.toFixed(1)}`,
    shutterLabel(camera?.shutter),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Lightroom-style histogram at the top of Develop, with the EXIF line and clipping switches. */
export function Histogram({ photo }: { photo: Photo | undefined }) {
  const mode = useDevelopViewMode();
  const histogram = useHistogram(photo?.id);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(260);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = (): void => setWidth(canvas.clientWidth || 260);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) draw(canvas, histogram);
  }, [histogram, width]);

  const exif = exifLine(photo);
  return (
    <div
      className={styles.histogram}
      data-testid="histogram"
      data-has-data={histogram ? 'true' : 'false'}
    >
      <div className={styles.graph}>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Histogram" />
        <button
          type="button"
          className={`${styles.clip} ${styles.clipShadows} ${mode.clipShadows ? styles.clipOn : ''}`}
          title="Show crushed shadows (blue)"
          aria-label="Toggle shadow clipping"
          aria-pressed={mode.clipShadows}
          data-testid="clip-shadows"
          onClick={toggleClipShadows}
        >
          <svg viewBox="0 0 10 8" aria-hidden>
            <path d="M0 0 L10 0 L5 8 Z" />
          </svg>
        </button>
        <button
          type="button"
          className={`${styles.clip} ${styles.clipHighlights} ${mode.clipHighlights ? styles.clipOn : ''}`}
          title="Show clipped highlights (red)"
          aria-label="Toggle highlight clipping"
          aria-pressed={mode.clipHighlights}
          data-testid="clip-highlights"
          onClick={toggleClipHighlights}
        >
          <svg viewBox="0 0 10 8" aria-hidden>
            <path d="M0 0 L10 0 L5 8 Z" />
          </svg>
        </button>
      </div>
      <div className={`${styles.exif} mono`} data-testid="histogram-exif">
        {exif ?? (photo ? 'EXIF unavailable' : 'No photo selected')}
      </div>
    </div>
  );
}
