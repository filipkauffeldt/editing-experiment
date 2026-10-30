import type { EditParams, SliderParam, ToneCurvePoint } from '@ee/contracts';
import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import {
  PARAMETRIC_SPLIT_PARAMS,
  addCurvePoint,
  clampCurveCoordinate,
  curvePoints,
  curveValueAt,
  curveParamForChannel,
  isCurveEndpoint,
  moveCurvePoint,
  moveParametricSplit,
  parametricCurvePath,
  parametricCurveValueAt,
  parametricRegionAt,
  parametricSplitValues,
  pointCurvePath,
  regionValueFromDrag,
  removeCurvePoint,
  type CurveChannel,
} from '../tone-curve';
import styles from './ToneCurveEditor.module.css';

const GRAPH_SIZE = 255;
const POINT_HIT_RADIUS = 10;
const REGION_PARAMS = [
  'ParametricShadows',
  'ParametricDarks',
  'ParametricLights',
  'ParametricHighlights',
] as const satisfies readonly SliderParam[];
const SPLIT_LABELS = ['Shadow', 'Midtone', 'Highlight'] as const;

interface GraphPoint {
  x: number;
  y: number;
  inside: boolean;
}

type Drag =
  | { kind: 'point'; pointerId: number; index: number }
  | {
      kind: 'region';
      pointerId: number;
      region: 0 | 1 | 2 | 3;
      startValue: number;
      startY: number;
    }
  | {
      kind: 'split';
      pointerId: number;
      index: number;
      startX: number;
      startValue: number;
      width: number;
    };

export interface ToneCurveEditorProps {
  channel: CurveChannel;
  params: EditParams;
  disabled?: boolean;
  /** Optional luminance histogram (256 bins) drawn faintly behind the curve. */
  histogram?: readonly number[];
  onChangePoints(points: ToneCurvePoint[]): void;
  onChangeParam(name: SliderParam, value: number): void;
  onReset(): void;
}

function pointIndexAt(points: readonly ToneCurvePoint[], x: number, y: number): number {
  return points.findIndex(([px, py]) => Math.hypot(px - x, py - y) <= POINT_HIT_RADIUS);
}

function graphPoint(element: Element, clientX: number, clientY: number): GraphPoint {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0, inside: false };
  const x = ((clientX - rect.left) / rect.width) * GRAPH_SIZE;
  const y = GRAPH_SIZE - ((clientY - rect.top) / rect.height) * GRAPH_SIZE;
  return {
    x,
    y,
    inside: x >= 0 && x <= GRAPH_SIZE && y >= 0 && y <= GRAPH_SIZE,
  };
}

function histogramPath(bins: readonly number[]): string {
  if (bins.length === 0) return '';
  const peak = Math.max(...bins.filter((value) => Number.isFinite(value)), 0);
  if (peak <= 0) return '';
  const points = bins.map((value, index) => {
    const x = (index / Math.max(1, bins.length - 1)) * GRAPH_SIZE;
    const y = GRAPH_SIZE - (Math.min(peak, Math.max(0, value)) / peak) * GRAPH_SIZE;
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return `M0 ${GRAPH_SIZE} L${points.join(' L')} L${GRAPH_SIZE} ${GRAPH_SIZE} Z`;
}

function clampRegion(value: number): number {
  return Math.min(100, Math.max(-100, Math.round(value)));
}

export function ToneCurveEditor({
  channel,
  params,
  disabled = false,
  histogram,
  onChangePoints,
  onChangeParam,
  onReset,
}: ToneCurveEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const splitTrackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const addedRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const [hover, setHover] = useState<GraphPoint | null>(null);

  const parametric = channel === 'Parametric';
  const param = curveParamForChannel(channel);
  const points = param ? curvePoints(params, channel as Exclude<CurveChannel, 'Parametric'>) : [];
  const splits = parametricSplitValues(params);
  const path = parametric ? parametricCurvePath(params) : pointCurvePath(points);
  const valueAtHover = hover
    ? parametric
      ? parametricCurveValueAt(params, hover.x)
      : curveValueAt(points, hover.x)
    : null;

  const capture = (element: Element, pointerId: number): void => {
    const target = element as Element & { setPointerCapture?(id: number): void };
    target.setPointerCapture?.(pointerId);
  };

  const release = (element: Element, pointerId: number): void => {
    const target = element as Element & { releasePointerCapture?(id: number): void };
    target.releasePointerCapture?.(pointerId);
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    if (disabled || event.button !== 0 || !svgRef.current) return;
    event.preventDefault();
    const point = graphPoint(svgRef.current, event.clientX, event.clientY);

    if (parametric) {
      const region = parametricRegionAt(splits, point.x);
      dragRef.current = {
        kind: 'region',
        pointerId: event.pointerId,
        region,
        startValue: params[REGION_PARAMS[region]] ?? 0,
        startY: point.y,
      };
      capture(svgRef.current, event.pointerId);
      return;
    }

    const hit = pointIndexAt(points, point.x, point.y);
    if (hit >= 0) {
      dragRef.current = { kind: 'point', pointerId: event.pointerId, index: hit };
      capture(svgRef.current, event.pointerId);
      return;
    }

    const x = clampCurveCoordinate(point.x);
    const y = clampCurveCoordinate(point.y);
    const next = addCurvePoint(points, x, y);
    const index = next.findIndex(([px]) => px === x);
    addedRef.current = { x, y, at: event.timeStamp };
    dragRef.current = { kind: 'point', pointerId: event.pointerId, index };
    onChangePoints(next);
    capture(svgRef.current, event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (!svgRef.current) return;
    const point = graphPoint(svgRef.current, event.clientX, event.clientY);
    setHover(point);
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (drag.kind === 'point') {
      onChangePoints(moveCurvePoint(points, drag.index, point.x, point.y));
      return;
    }
    if (drag.kind === 'region') {
      const value = regionValueFromDrag(drag.startValue, point.y - drag.startY);
      onChangeParam(REGION_PARAMS[drag.region], clampRegion(value));
      return;
    }

    const delta = ((event.clientX - drag.startX) / Math.max(1, drag.width)) * 100;
    const moved = moveParametricSplit(splits, drag.index, drag.startValue + delta);
    onChangeParam(
      PARAMETRIC_SPLIT_PARAMS[drag.index] ?? 'ParametricShadowSplit',
      moved[drag.index] ?? 0,
    );
  };

  const finishDrag = (event: PointerEvent<SVGSVGElement>, cancelled: boolean): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (svgRef.current) release(svgRef.current, event.pointerId);
    if (!drag || drag.kind !== 'point' || cancelled || !svgRef.current) return;
    const point = graphPoint(svgRef.current, event.clientX, event.clientY);
    if (!point.inside && !isCurveEndpoint(points, drag.index)) {
      onChangePoints(removeCurvePoint(points, drag.index));
    }
  };

  const onDoubleClick = (event: MouseEvent<SVGSVGElement>): void => {
    if (disabled || !svgRef.current) return;
    event.preventDefault();
    const point = graphPoint(svgRef.current, event.clientX, event.clientY);
    if (parametric) {
      onReset();
      return;
    }
    const hit = pointIndexAt(points, point.x, point.y);
    const added = addedRef.current;
    const justAdded =
      added !== null &&
      event.timeStamp - added.at < 600 &&
      Math.abs(added.x - point.x) <= POINT_HIT_RADIUS &&
      Math.abs(added.y - point.y) <= POINT_HIT_RADIUS;
    if (hit >= 0 && !justAdded && !isCurveEndpoint(points, hit)) {
      onChangePoints(removeCurvePoint(points, hit));
      return;
    }
    onReset();
  };

  const onSplitPointerDown = (index: number, event: PointerEvent<HTMLButtonElement>): void => {
    if (disabled || event.button !== 0 || !splitTrackRef.current) return;
    event.preventDefault();
    const rect = splitTrackRef.current.getBoundingClientRect();
    dragRef.current = {
      kind: 'split',
      pointerId: event.pointerId,
      index,
      startX: event.clientX,
      startValue: splits[index] ?? 0,
      width: rect.width,
    };
    capture(event.currentTarget, event.pointerId);
  };

  const onSplitPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== 'split' || drag.pointerId !== event.pointerId) return;
    const delta = ((event.clientX - drag.startX) / Math.max(1, drag.width)) * 100;
    const moved = moveParametricSplit(splits, drag.index, drag.startValue + delta);
    onChangeParam(
      PARAMETRIC_SPLIT_PARAMS[drag.index] ?? 'ParametricShadowSplit',
      moved[drag.index] ?? 0,
    );
  };

  const onSplitPointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    if (dragRef.current?.kind !== 'split') return;
    dragRef.current = null;
    release(event.currentTarget, event.pointerId);
  };

  const onSplitKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 5 : 1;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const moved = moveParametricSplit(splits, index, (splits[index] ?? 0) + direction * step);
    onChangeParam(PARAMETRIC_SPLIT_PARAMS[index] ?? 'ParametricShadowSplit', moved[index] ?? 0);
  };

  return (
    <div className={styles.editor}>
      <svg
        ref={svgRef}
        className={styles.graph}
        viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
        role="img"
        aria-label={`Tone curve, ${channel}`}
        data-testid="tone-curve-graph"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finishDrag(event, false)}
        onPointerCancel={(event) => finishDrag(event, true)}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
      >
        <rect className={styles.background} width={GRAPH_SIZE} height={GRAPH_SIZE} />
        {histogram && histogram.length > 0 && (
          <path
            className={styles.histogram}
            d={histogramPath(histogram)}
            data-testid="tone-curve-histogram"
          />
        )}
        {[63.75, 127.5, 191.25].map((value) => (
          <g key={value} className={styles.grid}>
            <line x1={value} y1={0} x2={value} y2={GRAPH_SIZE} />
            <line x1={0} y1={value} x2={GRAPH_SIZE} y2={value} />
          </g>
        ))}
        <line className={styles.diagonal} x1={0} y1={GRAPH_SIZE} x2={GRAPH_SIZE} y2={0} />
        {parametric &&
          splits.map((split) => (
            <line
              key={split}
              className={styles.splitLine}
              x1={(split / 100) * GRAPH_SIZE}
              y1={0}
              x2={(split / 100) * GRAPH_SIZE}
              y2={GRAPH_SIZE}
            />
          ))}
        <path className={styles.curve} d={path} data-testid="tone-curve-path" />
        {!parametric &&
          points.map(([x, y], index) => (
            <circle
              key={`${index}:${x}:${y}`}
              className={`${styles.point} ${isCurveEndpoint(points, index) ? styles.endpoint : ''}`}
              cx={x}
              cy={GRAPH_SIZE - y}
              r={isCurveEndpoint(points, index) ? 4 : 4.5}
              data-testid={`tone-curve-point-${index}`}
              data-input={Math.round(x)}
              data-output={Math.round(y)}
              onPointerDown={(event) => {
                if (disabled) return;
                event.stopPropagation();
                event.preventDefault();
                dragRef.current = { kind: 'point', pointerId: event.pointerId, index };
                capture(event.currentTarget, event.pointerId);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (disabled || isCurveEndpoint(points, index)) return;
                onChangePoints(removeCurvePoint(points, index));
              }}
            />
          ))}
        {hover && hover.inside && (
          <line className={styles.crosshair} x1={hover.x} y1={0} x2={hover.x} y2={GRAPH_SIZE} />
        )}
      </svg>
      <div className={`${styles.readout} mono`} data-testid="tone-curve-readout" aria-live="off">
        {hover && hover.inside && valueAtHover !== null
          ? `${Math.round(hover.x)} → ${Math.round(valueAtHover)}`
          : '—'}
      </div>
      {parametric && (
        <div
          ref={splitTrackRef}
          className={styles.splitTrack}
          data-testid="tone-curve-splits"
          role="group"
          aria-label="Parametric curve split points"
        >
          {SPLIT_LABELS.map((label, index) => (
            <button
              key={label}
              type="button"
              className={styles.splitHandle}
              style={{ left: `${splits[index] ?? 0}%` }}
              aria-label={`${label} split`}
              data-testid={`tone-curve-split-${label.toLowerCase()}`}
              onPointerDown={(event) => onSplitPointerDown(index, event)}
              onPointerMove={onSplitPointerMove}
              onPointerUp={onSplitPointerUp}
              onPointerCancel={onSplitPointerUp}
              onKeyDown={(event) => onSplitKeyDown(index, event)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
