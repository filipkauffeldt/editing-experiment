import type { EditParams, SliderParam } from '@ee/contracts';
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import {
  applyWheelDrag,
  clampSaturation,
  normalizeHue,
  pointFromHueSat,
  wheelDragMode,
  type WheelHueSat,
} from '../grading-wheel';
import { Slider } from './ui/Slider';
import styles from './ColorGradingWheels.module.css';

export const GRADING_REGIONS = ['Shadows', 'Midtones', 'Highlights', 'Global'] as const;
export type GradingRegion = (typeof GRADING_REGIONS)[number];
export type GradingView = '3-way' | GradingRegion;

export const GRADING_VIEWS: readonly GradingView[] = ['3-way', ...GRADING_REGIONS];

const PREFIX: Readonly<Record<GradingRegion, string>> = {
  Shadows: 'ColorGradeShadow',
  Midtones: 'ColorGradeMidtone',
  Highlights: 'ColorGradeHighlight',
  Global: 'ColorGradeGlobal',
};

const WHEEL_SIZE = 96;
const CENTRE = WHEEL_SIZE / 2;
const RING_INNER = 36;
const RING_OUTER = 43;
const PUCK_RADIUS = 4.5;

export const hueParam = (region: GradingRegion): SliderParam =>
  `${PREFIX[region]}Hue` as SliderParam;
export const satParam = (region: GradingRegion): SliderParam =>
  `${PREFIX[region]}Sat` as SliderParam;
export const lumParam = (region: GradingRegion): SliderParam =>
  `${PREFIX[region]}Lum` as SliderParam;

interface DragState {
  pointerId: number;
  start: WheelHueSat;
}

const value = (params: EditParams, name: SliderParam, neutral = 0): number => {
  const raw = params[name];
  if (raw === undefined || !Number.isFinite(raw)) return neutral;
  return raw;
};

function wheelPoint(
  element: Element,
  clientX: number,
  clientY: number,
): { dx: number; dy: number; hasLayout: boolean } {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) return { dx: 0, dy: 0, hasLayout: false };
  const scale = WHEEL_SIZE / rect.width;
  return {
    dx: (clientX - rect.left) * scale - CENTRE,
    dy: (clientY - rect.top) * scale - CENTRE,
    hasLayout: true,
  };
}

function modifiersOf(event: PointerEvent | KeyboardEvent): {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  altGraph: boolean;
} {
  const target = event as { getModifierState?(key: string): boolean };
  return {
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    altGraph: target.getModifierState?.('AltGraph') ?? false,
  };
}

interface WheelProps {
  region: GradingRegion;
  params: EditParams;
  disabled?: boolean;
  onChange(name: SliderParam, value: number | undefined): void;
}

function Wheel({ region, params, disabled = false, onChange }: WheelProps) {
  const dragRef = useRef<DragState | null>(null);
  const hue = normalizeHue(value(params, hueParam(region)));
  const sat = clampSaturation(value(params, satParam(region)));
  const lum = value(params, lumParam(region));
  const puck = pointFromHueSat(hue, sat, RING_OUTER);

  const capture = (element: Element, pointerId: number): void => {
    const target = element as Element & { setPointerCapture?(id: number): void };
    target.setPointerCapture?.(pointerId);
  };

  const release = (element: Element, pointerId: number): void => {
    const target = element as Element & { releasePointerCapture?(id: number): void };
    target.releasePointerCapture?.(pointerId);
  };

  const apply = (event: PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = wheelPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point.hasLayout) return;
    const next = applyWheelDrag(
      drag.start,
      point.dx,
      point.dy,
      RING_OUTER,
      wheelDragMode(modifiersOf(event)),
    );
    onChange(hueParam(region), next.hue);
    onChange(satParam(region), next.sat);
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, start: { hue, sat } };
    event.currentTarget.focus();
    capture(event.currentTarget, event.pointerId);
    apply(event);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    apply(event);
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    release(event.currentTarget, event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>): void => {
    if (disabled) return;
    const step = event.shiftKey ? 5 : 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      onChange(hueParam(region), normalizeHue(hue + direction * step));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowUp' ? 1 : -1;
      onChange(satParam(region), clampSaturation(sat + direction * step));
    }
  };

  const reset = (): void => {
    onChange(hueParam(region), 0);
    onChange(satParam(region), 0);
  };

  const segments = Array.from({ length: 72 }, (_, index) => index * 5);

  return (
    <div className={styles.wheelColumn} data-testid={`grading-${region.toLowerCase()}`}>
      <span className={styles.regionName}>{region}</span>
      <svg
        className={styles.wheel}
        viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${region} colour wheel`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={sat}
        aria-valuetext={`Hue ${hue}, saturation ${sat}`}
        aria-disabled={disabled}
        data-testid={`grading-wheel-${region.toLowerCase()}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <circle className={styles.outline} cx={CENTRE} cy={CENTRE} r={RING_OUTER} />
        {segments.map((hueValue) => {
          const angle = (hueValue * Math.PI) / 180;
          const x1 = CENTRE + Math.cos(angle) * RING_INNER;
          const y1 = CENTRE - Math.sin(angle) * RING_INNER;
          const x2 = CENTRE + Math.cos(angle) * RING_OUTER;
          const y2 = CENTRE - Math.sin(angle) * RING_OUTER;
          return (
            <line
              key={hueValue}
              className={styles.segment}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              style={{ '--wheel-hue': String(hueValue) } as CSSProperties}
            />
          );
        })}
        <line className={styles.crosshair} x1={CENTRE} y1={8} x2={CENTRE} y2={WHEEL_SIZE - 8} />
        <line className={styles.crosshair} x1={8} y1={CENTRE} x2={WHEEL_SIZE - 8} y2={CENTRE} />
        <circle
          className={styles.puck}
          cx={CENTRE + puck.x}
          cy={CENTRE + puck.y}
          r={PUCK_RADIUS}
          data-testid={`grading-puck-${region.toLowerCase()}`}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (!disabled) reset();
          }}
        />
      </svg>
      <span className={`${styles.values} mono`}>
        H {hue} · S {sat}
      </span>
      <Slider
        label="Lum"
        ariaLabel={`${region} luminance`}
        value={lum}
        min={-100}
        max={100}
        step={1}
        neutral={0}
        display={lum}
        compact
        disabled={disabled}
        onRange={(next) => onChange(lumParam(region), next)}
        onNumber={(next) => onChange(lumParam(region), next)}
        onReset={() => onChange(lumParam(region), undefined)}
      />
    </div>
  );
}

export interface ColorGradingWheelsProps {
  view: GradingView;
  params: EditParams;
  disabled?: boolean;
  onChange(name: SliderParam, value: number | undefined): void;
}

/** 3-way shows Shadows/Midtones/Highlights; the other views show one larger wheel. */
export function ColorGradingWheels({ view, params, disabled, onChange }: ColorGradingWheelsProps) {
  const regions: readonly GradingRegion[] =
    view === '3-way' ? ['Shadows', 'Midtones', 'Highlights'] : [view];
  return (
    <div
      className={`${styles.wheels} ${view === '3-way' ? '' : styles.single}`}
      data-testid="color-grading-wheels"
    >
      {regions.map((region) => (
        <Wheel
          key={region}
          region={region}
          params={params}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
