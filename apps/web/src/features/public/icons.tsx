/*
 * The glyphs on the homeowner pages: one 24-grid line set with a 1.7 stroke, round caps and joins, in the current
 * text colour (REDESIGN 5.5). Decorative: the words beside each one carry the meaning, so none is in the
 * accessibility tree.
 */
import type { ReactNode } from 'react';

function Glyph({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export const CheckIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Glyph>
);

export const PhoneIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M5 3.5h3.2l1.6 4.2-2.1 1.3a11 11 0 0 0 5.3 5.3l1.3-2.1 4.2 1.6V17a2.5 2.5 0 0 1-2.7 2.5C9.5 19 4.9 14.4 4.5 6.2A2.5 2.5 0 0 1 5 3.5z" />
  </Glyph>
);

export const HomeIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M3 11 12 4l9 7" />
    <path d="M5.5 9.5V20h13V9.5" />
    <path d="M10 20v-5.5h4V20" />
  </Glyph>
);

export const RoofIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M3 12.5 12 5l9 7.5" />
    <path d="M6 11v8.5h12V11" />
  </Glyph>
);

export const WindowIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <rect x="4.5" y="4.5" width="15" height="15" rx="1.6" />
    <path d="M12 4.5v15M4.5 12h15" />
  </Glyph>
);

export const GutterIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M3.5 8h17v3.5h-17z" />
    <path d="M17.5 11.5V19M15 19h5" />
  </Glyph>
);

export const PenIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="m4 20 1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
    <path d="m14.5 6.5 3 3" />
  </Glyph>
);

export const DocIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M7 3.5h7l4 4V20.5H7z" />
    <path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5" />
  </Glyph>
);

export const ArrowIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Glyph>
);

export const MinusIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M5 12h14" />
  </Glyph>
);

export const PlusIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M12 5v14M5 12h14" />
  </Glyph>
);

export const CameraIcon = ({ size }: IconProps) => (
  <Glyph size={size}>
    <path d="M4 8.5h3l1.5-2h7l1.5 2h3V18H4z" />
    <circle cx="12" cy="13" r="3.2" />
  </Glyph>
);
