import type { PanelWidthId } from '@ee/contracts';
import type { PanelResizeController, PanelSide } from '../../panel-resize';
import styles from './PanelResizeHandle.module.css';

interface PanelResizeHandleProps {
  panel: PanelWidthId;
  label: string;
  side: PanelSide;
  controller: PanelResizeController;
  className?: string;
}

const verticalSide = (side: PanelSide): boolean => side === 'left' || side === 'right';

/** The arrow key moves the separator itself, so the panel on the far side grows or shrinks. */
function arrowDelta(side: PanelSide, key: string): -1 | 0 | 1 {
  if (verticalSide(side)) {
    if (key === 'ArrowLeft') return side === 'left' ? -1 : 1;
    if (key === 'ArrowRight') return side === 'left' ? 1 : -1;
    return 0;
  }
  if (key === 'ArrowUp') return side === 'bottom' ? 1 : -1;
  if (key === 'ArrowDown') return side === 'bottom' ? -1 : 1;
  return 0;
}

/**
 * The hairline on a panel's inner edge. Its line stays 1 px and sits on the
 * centre side of the edge, so it never covers a panel scrollbar or a thumbnail;
 * the invisible hit area reaches into the centre, where there is nothing to
 * click.
 */
export function PanelResizeHandle({
  panel,
  label,
  side,
  controller,
  className,
}: PanelResizeHandleProps) {
  return (
    <div
      className={`${styles.handle} ${className ?? ''}`}
      data-testid={`panel-resize-${panel}`}
      data-side={side}
      data-dragging={controller.dragging}
      role="separator"
      aria-label={`Resize ${label}`}
      aria-orientation={verticalSide(side) ? 'vertical' : 'horizontal'}
      aria-valuemin={controller.min}
      aria-valuemax={controller.max}
      aria-valuenow={Math.round(controller.size)}
      tabIndex={0}
      title={`Drag to resize ${label.toLowerCase()}. Double-click to reset.`}
      {...controller.handlers}
      onDoubleClick={() => controller.reset()}
      onKeyDown={(event) => {
        const delta = arrowDelta(side, event.key);
        if (delta === 0) return;
        event.preventDefault();
        event.stopPropagation();
        controller.nudge(delta * (event.shiftKey ? 32 : 8));
      }}
    />
  );
}
