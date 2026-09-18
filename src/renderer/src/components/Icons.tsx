/**
 * Inline SVG icons.
 *
 * All 1.6–1.8px stroke, `currentColor`, no fills except where a shape needs
 * one, and no emoji anywhere. Bundled rather than fetched: the packaged build
 * has no network font or icon dependency.
 *
 * The handoff calls for one cohesive thin/medium-stroke set. These are drawn to
 * that spec so the product has no icon dependency at all; swapping in Lucide or
 * Phosphor later is a contained change because every call site uses this
 * module.
 */

import type { ReactNode, SVGProps } from 'react';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  readonly size?: number;
  readonly title?: string;
}

function Icon({
  size = 14,
  title,
  children,
  ...rest
}: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title === undefined}
      role={title === undefined ? undefined : 'img'}
      focusable="false"
      {...rest}
    >
      {title === undefined ? null : <title>{title}</title>}
      {children}
    </svg>
  );
}

export function ChargerIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M9 3v3M15 3v3" />
      <path d="M7 6h10v6a5 5 0 0 1-10 0z" />
      <path d="M12 17v4" />
    </Icon>
  );
}

export function CalendarIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronUpIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="m6 15 6-6 6 6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

/** Chevron-left plus a bar: the collapse control from the handoff. */
export function CollapseIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props} size={props.size ?? 16}>
      <path d="m13 8-4 4 4 4" />
      <path d="M19 5v14" />
    </Icon>
  );
}

/** Chevron-right plus a bar: the expand control. */
export function ExpandIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props} size={props.size ?? 16}>
      <path d="m11 8 4 4-4 4" />
      <path d="M5 5v14" />
    </Icon>
  );
}

export function BookmarkIcon({
  filled = false,
  ...props
}: IconProps & { filled?: boolean }): ReactNode {
  return (
    <Icon {...props} fill={filled ? 'currentColor' : 'none'}>
      <path d="M7 4h10v16l-5-4-5 4z" />
    </Icon>
  );
}

export function WarningIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props} size={props.size ?? 15}>
      <path d="M12 4.5 21 19H3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.6" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

/** Crosshair: reset view. */
export function CrosshairIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Icon>
  );
}

/** Fit-frame: fit the filtered stations. */
export function FitFrameIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
    </Icon>
  );
}

/** Dashed target: the study-radius toggle. */
export function StudyRadiusIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function GearIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props} size={props.size ?? 16}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M12 4v11M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </Icon>
  );
}

export function ExternalIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M14 5h5v5" />
      <path d="m19 5-8 8" />
      <path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5A1.5 1.5 0 0 1 6 6h4" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4h-4" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M9 5v14M15 5v14" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M8 5l11 7-11 7z" />
    </Icon>
  );
}

export function FolderIcon(props: IconProps): ReactNode {
  return (
    <Icon {...props}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
    </Icon>
  );
}
