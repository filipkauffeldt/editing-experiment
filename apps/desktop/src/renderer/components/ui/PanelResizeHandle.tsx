import type { PanelWidthId } from '@ee/contracts';
import { PANEL_WIDTH_SPECS } from '../../../shared/panel-widths';
import type { PanelResizeController, PanelSide } from '../../panel-resize';
import styles from './PanelResizeHandle.module.css';

interface PanelResizeHandleProps {
  panel: PanelWidthId;
  label: string;
  side: PanelSide;
  controller: PanelResizeController;
  className?: string;
}

/**
 * The hairline on a side panel's inner edge. Its visible line stays 1 px wide
 * and sits on the centre side of the edge, so it never covers a panel
 * scrollbar; the invisible hit area reaches into the centre, where there is
 * nothing to click.
 */
export function PanelResizeHandle({
  panel,
  label,
  side,
  controller,
  className,
}: PanelResizeHandleProps) {
  const spec = PANEL_WIDTH_SPECS[panel];
  return (
    <div
      className={`${styles.handle} ${className ?? ''}`}
      data-testid={`panel-resize-${panel}`}
      data-side={side}
      data-dragging={controller.dragging}
      role="separator"
      aria-label={`Resize ${label}`}
      aria-orientation="vertical"
      aria-valuemin={spec.minWidth}
      aria-valuemax={spec.maxWidth}
      aria-valuenow={Math.round(controller.width)}
      title={`Drag to resize ${label.toLowerCase()}. Double-click to reset.`}
      {...controller.handlers}
      onDoubleClick={() => controller.reset()}
    />
  );
}
