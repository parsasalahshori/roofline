import { z } from 'zod';

/*
 * The look a homeowner chose for one window in the phone app's "Customize your windows" step: the kind of window, the grid
 * across the glass, the glass, and the frame colour. The values are the iPhone app's own (RooflineCore, WindowVisual.swift),
 * so the CRM shows what the homeowner saw. A look is descriptive: it does not change the quote (the window's `style` does).
 */

/** The kinds of window the app can draw (VisualWindowType). */
export const WINDOW_LOOK_KINDS = ['doubleHung', 'singleHung', 'slider2', 'slider3', 'casement', 'casementPair', 'awning', 'hopper', 'picture', 'pictureCasements', 'bay', 'bow', 'garden', 'arch', 'halfRound', 'circle', 'specialty'] as const;
/** The grid across the glass (VisualGrid). */
export const WINDOW_LOOK_GRIDS = ['none', 'colonial', 'prairie', 'diamond', 'queenAnne', 'topOnly'] as const;
/** The glass (VisualGlass). */
export const WINDOW_LOOK_GLASSES = ['clear', 'lowE', 'frosted'] as const;
/** A frame colour is the company's own key for it ("white", "black"): letters, digits, hyphen and underscore. */
export const WINDOW_LOOK_COLOR_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type WindowLookKind = (typeof WINDOW_LOOK_KINDS)[number];
export type WindowLookGrid = (typeof WINDOW_LOOK_GRIDS)[number];
export type WindowLookGlass = (typeof WINDOW_LOOK_GLASSES)[number];

export type WindowLook = { kind: WindowLookKind; grid: WindowLookGrid; glass: WindowLookGlass; color: string };

/** A look as it is checked on the way in (strict: an unknown key is refused). */
export const WindowLookSchema = z
  .object({
    kind: z.enum(WINDOW_LOOK_KINDS),
    grid: z.enum(WINDOW_LOOK_GRIDS),
    glass: z.enum(WINDOW_LOOK_GLASSES),
    color: z.string().regex(WINDOW_LOOK_COLOR_RE),
  })
  .strict();

const KIND_TITLES: Record<WindowLookKind, string> = {
  doubleHung: 'Double-hung',
  singleHung: 'Single-hung',
  slider2: '2-lite slider',
  slider3: '3-lite slider',
  casement: 'Casement',
  casementPair: 'Casement pair',
  awning: 'Awning',
  hopper: 'Hopper',
  picture: 'Picture',
  pictureCasements: 'Picture + casements',
  bay: 'Bay',
  bow: 'Bow',
  garden: 'Garden',
  arch: 'Arch top',
  halfRound: 'Half-round',
  circle: 'Circle',
  specialty: 'Specialty shape',
};
const GRID_TITLES: Record<WindowLookGrid, string> = { none: 'No grid', colonial: 'Colonial', prairie: 'Prairie', diamond: 'Diamond', queenAnne: 'Queen Anne', topOnly: 'Top-only' };
const GLASS_TITLES: Record<WindowLookGlass, string> = { clear: 'Clear', lowE: 'Low-E', frosted: 'Frosted' };

const capitalized = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

/** One readable line: "Casement · Prairie grid · Black · Low-E glass" (staff screens and the lead's summary). */
export function windowLookLine(look: WindowLook): string {
  return [KIND_TITLES[look.kind], look.grid === 'none' ? 'No grid' : `${GRID_TITLES[look.grid]} grid`, capitalized(look.color.replace(/[-_]+/g, ' ')), `${GLASS_TITLES[look.glass]} glass`].join(' · ');
}
