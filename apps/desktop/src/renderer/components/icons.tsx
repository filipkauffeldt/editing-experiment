import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 12, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PenIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 13h3l7.2-7.2a1.5 1.5 0 0 0 0-2.1l-.9-.9a1.5 1.5 0 0 0-2.1 0L3 10v3Z" />
      <path d="M9.4 4.6 11.4 6.6" />
    </Icon>
  );
}

export function CropIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 1.5v10a1 1 0 0 0 1 1h9" />
      <path d="M1.5 4.5h10a1 1 0 0 1 1 1v9" />
    </Icon>
  );
}

export function StackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="2.5" width="10" height="8" rx="1" />
      <path d="M1.5 6.5v5A1.5 1.5 0 0 0 3 13h7" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3 8.4 3.1 3.1L13 4.5" />
    </Icon>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.4 1.5" />
    </Icon>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 10.5V2.8M5.2 5.4 8 2.6l2.8 2.8" />
      <path d="M2.8 10v2.4c0 .5.3.8.8.8h8.8c.5 0 .8-.3.8-.8V10" />
    </Icon>
  );
}

/** Save/export: an arrow down into a tray, the mirror of the upload icon. */
export function ExportIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.8v7.7M5.2 7.8 8 10.6l2.8-2.8" />
      <path d="M2.8 10v2.4c0 .5.3.8.8.8h8.8c.5 0 .8-.3.8-.8V10" />
    </Icon>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M1.8 4.2h4.4l1.2 1.4h6.8v6.8c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z" />
      <path d="M1.8 5.6h12.4" />
    </Icon>
  );
}

export function ServerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.5" width="12" height="4.6" rx="1" />
      <rect x="2" y="8.9" width="12" height="4.6" rx="1" />
      <path d="M4.5 4.8h.5M4.5 11.2h.5" />
    </Icon>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.2 14 13H2z" />
      <path d="M8 6.2v3M8 11.2v.4" />
    </Icon>
  );
}

/** Circular arrow: scan again. */
export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </Icon>
  );
}

/** Edited: two slider rows with their knobs, as in Lightroom's edited badge. */
export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 5h5.6M12.4 5H14M2 11h1.6M8.4 11H14" />
      <circle cx="10" cy="5" r="2.4" />
      <circle cx="6" cy="11" r="2.4" />
    </Icon>
  );
}

/** Retouched: a block of mosaic squares. */
export function MosaicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M8 2.5v11M2.5 8h11" />
      <path d="M8 8h5.5v5.5H8z" fill="currentColor" />
    </Icon>
  );
}

/** Sent: a tick over a tray, the finished state of the upload arrow. */
export function SentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 6 2.2 2.2L11.2 3.8" />
      <path d="M2.8 10v2.4c0 .5.3.8.8.8h8.8c.5 0 .8-.3.8-.8V10" />
    </Icon>
  );
}

/** Metadata differs from the ingest template: not-equal. */
export function NotEqualIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 6h10M3 10.2h10M10.2 2.8 5.8 13.4" />
    </Icon>
  );
}
