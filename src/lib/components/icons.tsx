/**
 * Inline SVG icons (16 px, stroke-current). Decorative by default
 * (aria-hidden); pass `label` to expose an accessible name.
 */
import type { ReactNode, SVGProps } from "react";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  label?: string;
  size?: number;
}

function Svg({ label, size = 16, className = "", children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block shrink-0 ${className}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: IconProps) => <Svg {...p}><path d="M3 8.5l3 3 7-7" /></Svg>;
export const IconPencil = (p: IconProps) => <Svg {...p}><path d="M10.5 2.5l3 3L6 13H3v-3z" /></Svg>;
export const IconX = (p: IconProps) => <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
export const IconPause = (p: IconProps) => <Svg {...p}><path d="M5.5 3.5v9M10.5 3.5v9" /></Svg>;
export const IconCircle = (p: IconProps) => <Svg {...p}><circle cx="8" cy="8" r="5" /></Svg>;
export const IconInherited = (p: IconProps) => <Svg {...p}><path d="M3 8a5 5 0 1 0 1.5-3.5" /><path d="M3 2.5v3h3" /></Svg>;
export const IconChevronLeft = (p: IconProps) => <Svg {...p}><path d="M10 3L5 8l5 5" /></Svg>;
export const IconChevronRight = (p: IconProps) => <Svg {...p}><path d="M6 3l5 5-5 5" /></Svg>;
export const IconChevronDown = (p: IconProps) => <Svg {...p}><path d="M3 6l5 5 5-5" /></Svg>;
export const IconSearch = (p: IconProps) => <Svg {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></Svg>;
export const IconPlus = (p: IconProps) => <Svg {...p}><path d="M8 3v10M3 8h10" /></Svg>;
export const IconCopy = (p: IconProps) => <Svg {...p}><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" /></Svg>;
export const IconLock = (p: IconProps) => <Svg {...p}><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></Svg>;
export const IconFlag = (p: IconProps) => <Svg {...p}><path d="M3.5 14V2.5M3.5 3h8l-2 3 2 3h-8" /></Svg>;
export const IconAlert = (p: IconProps) => <Svg {...p}><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.5v.2" /></Svg>;
export const IconInfo = (p: IconProps) => <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 7.5v4M8 5v.2" /></Svg>;
export const IconExternal = (p: IconProps) => <Svg {...p}><path d="M9 3h4v4M13 3L7 9M11 9.5V13H3V5h3.5" /></Svg>;
export const IconCube = (p: IconProps) => <Svg {...p}><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" /><path d="M2.5 4.8L8 8l5.5-3.2M8 8v6.2" /></Svg>;
export const IconNoCube = (p: IconProps) => <Svg {...p}><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" /><path d="M2 2l12 12" /></Svg>;
export const IconUndo = (p: IconProps) => <Svg {...p}><path d="M5.5 4L2.5 7l3 3" /><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H7" /></Svg>;
export const IconStar = (p: IconProps) => <Svg {...p}><path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" /></Svg>;
export const IconArrowUp = (p: IconProps) => <Svg {...p}><path d="M8 13V3M4 7l4-4 4 4" /></Svg>;
export const IconArrowDown = (p: IconProps) => <Svg {...p}><path d="M8 3v10M4 9l4 4 4-4" /></Svg>;
export const IconKeyboard = (p: IconProps) => <Svg {...p}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.1M6.5 7h.1M9 7h.1M11.5 7h.1M5 9.5h6" /></Svg>;
export const IconFit = (p: IconProps) => <Svg {...p}><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></Svg>;
export const IconSection = (p: IconProps) => <Svg {...p}><rect x="3" y="3" width="10" height="10" rx="1" strokeDasharray="2 1.5" /></Svg>;
export const IconMarker = (p: IconProps) => <Svg {...p}><circle cx="8" cy="7" r="2" /><path d="M8 14s4.5-4 4.5-7a4.5 4.5 0 0 0-9 0c0 3 4.5 7 4.5 7z" /></Svg>;
export const IconDownload = (p: IconProps) => <Svg {...p}><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11" /></Svg>;

/** Side A swatch: filled square (Okabe-Ito blue). */
export function SideASwatch({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 bg-clash-a ${className}`} />;
}

/** Side B swatch: filled triangle (Okabe-Ito orange). */
export function SideBSwatch({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className={`inline-block fill-clash-b ${className}`}>
      <path d="M5 0.5L9.5 9.5H0.5z" />
    </svg>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-4 w-4 rounded-full border-2 border-brand/20 border-t-brand animate-spin motion-reduce:animate-none ${className}`}
    />
  );
}
/** ACC issue assigned (ticket). */
export const IconIssue = (p: IconProps) => <Svg {...p}><rect x="3" y="2.5" width="10" height="11" rx="1.5" /><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" /></Svg>;
/** Closed in ACC (circle with a bar). */
export const IconClosed = (p: IconProps) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></Svg>;
