/*
 * The icon set (design/REDESIGN.md 5.5): one 24-grid line set, 1.7 stroke, round caps and joins, drawn in
 * currentColor so an icon takes the colour of the text beside it. Sizes are 16, 18 and 22. Glyphs are
 * decorative (aria-hidden): the control or the word beside an icon names it. No emoji anywhere.
 * Generated from the design's _icons.svg.
 */
import type { ReactNode } from 'react';

const GLYPHS = {
  home: (
    <>
      <path d="M3 11 12 4l9 7" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M10 20v-5.5h4V20" />
    </>
  ),
  day: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
    </>
  ),
  jobs: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.2" />
      <rect x="9.5" y="4" width="5" height="11" rx="1.2" />
      <rect x="16" y="4" width="5" height="7" rx="1.2" />
    </>
  ),
  cal: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
      <path d="M7.5 14h2M11 14h2M14.5 14h2M7.5 17h2M11 17h2" />
    </>
  ),
  ruler: (
    <>
      <path d="M3.5 16.5 16.5 3.5l4 4-13 13z" />
      <path d="M7 13l2 2M9.5 10.5l1.5 1.5M12 8l2 2M14.5 5.5l1.5 1.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5" />
      <path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.8c1.8.6 3 2.2 3.4 4.7" />
    </>
  ),
  phone: (
    <>
      <path d="M5 3.5h3.2l1.6 4.2-2.1 1.3a11 11 0 0 0 5.3 5.3l1.3-2.1 4.2 1.6V17a2.5 2.5 0 0 1-2.7 2.5C9.5 19 4.9 14.4 4.5 6.2A2.5 2.5 0 0 1 5 3.5z" />
    </>
  ),
  agents: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3.5V7M9 12.5v1.5M15 12.5v1.5M2 12v3M22 12v3" />
    </>
  ),
  'check2': (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12.2 2.7 2.7L16.2 9" />
    </>
  ),
  storm: (
    <>
      <path d="M7 15.5a4.5 4.5 0 1 1 1.2-8.8A5.5 5.5 0 0 1 18.8 9 3.3 3.3 0 0 1 18 15.5z" />
      <circle cx="8.5" cy="19" r=".9" />
      <circle cx="12.5" cy="20.5" r=".9" />
      <circle cx="16" cy="18.8" r=".9" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  minus: (
    <>
      <path d="M5 12h14" />
    </>
  ),
  chev: (
    <>
      <path d="m9 6 6 6-6 6" />
    </>
  ),
  chevd: (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  chevl: (
    <>
      <path d="m15 6-6 6 6 6" />
    </>
  ),
  check: (
    <>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </>
  ),
  x: (
    <>
      <path d="M6 6l12 12M18 6 6 18" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </>
  ),
  filter: (
    <>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 4 9 5-9 5-9-5z" />
      <path d="m3 14 9 5 9-5" />
    </>
  ),
  win: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="1" />
      <path d="M5 12h14M12 3.5V12" />
    </>
  ),
  roof: (
    <>
      <path d="M2.5 12.5 12 5l9.5 7.5" />
      <path d="M5 10.5V19h14v-8.5" />
      <path d="M9 19v-4h6v4" />
    </>
  ),
  gutter: (
    <>
      <path d="M3 7h18v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M17 12v8" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3.5h8l4 4V20.5H6z" />
      <path d="M14 3.5V8h4M9 12h6M9 15.5h6" />
    </>
  ),
  pen: (
    <>
      <path d="M4 20l1-4.5L15.5 5a2 2 0 0 1 3 3L8 18.5z" />
      <path d="M13.5 7 17 10.5" />
    </>
  ),
  msg: (
    <>
      <path d="M4 5.5h16v11H9l-5 4z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 10v4.5M12 17.3v.2" />
    </>
  ),
  cube: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  truck: (
    <>
      <path d="M2.5 6h11v10h-11zM13.5 9.5h4l3 3.5V16h-7" />
      <circle cx="7" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  factory: (
    <>
      <path d="M3 20V10l5 3V10l5 3V5h4l1 15z" />
      <path d="M3 20h18" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l1.6-2.5h6.8L17 8h3v11H4z" />
      <circle cx="12" cy="13.2" r="3.4" />
    </>
  ),
  dollar: (
    <>
      <path d="M12 3v18M16.5 7.5c-.8-1.3-2.4-2-4.5-2-2.6 0-4.3 1.3-4.3 3.2 0 4.6 9 2.4 9 7.2 0 2-1.9 3.4-4.7 3.4-2.2 0-4-.8-4.8-2.3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
    </>
  ),
  map: (
    <>
      <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </>
  ),
  dots: (
    <>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </>
  ),
  drag: (
    <>
      <circle cx="9" cy="6.5" r="1.1" />
      <circle cx="15" cy="6.5" r="1.1" />
      <circle cx="9" cy="12" r="1.1" />
      <circle cx="15" cy="12" r="1.1" />
      <circle cx="9" cy="17.5" r="1.1" />
      <circle cx="15" cy="17.5" r="1.1" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v5h16v-5" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L20 9.5" />
      <path d="M20 4.5v5h-5" />
    </>
  ),
  lidar: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
    </>
  ),
  sheet: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M4 8.5h16M8.5 4v16" strokeDasharray="2 2" />
    </>
  ),
  bolt: (
    <>
      <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />
    </>
  ),
  star: (
    <>
      <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  flash: (
    <>
      <path d="M12 3v3M12 18v3M5 12H2M22 12h-3" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13.5 6 5h12l2.5 8.5V19h-17z" />
      <path d="M3.5 13.5H9l1 2h4l1-2h5.5" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M8 18h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof GLYPHS;

/** Every icon name, for tests and pickers. */
export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];

export type IconProps = {
  name: IconName;
  /** 16 in tags and dense rows, 18 by default, 22 on phone tab bars and headers. */
  size?: 16 | 18 | 22;
  className?: string;
  /** Gives the glyph a name for assistive tech (a lock beside a locked field). Left out, it is decoration. */
  label?: string;
};

export function Icon({ name, size = 18, className, label }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
      className={className}
      style={{ flex: 'none' }}
    >
      {GLYPHS[name]}
    </svg>
  );
}
