import type { HomeownerArScale, HomeownerCardScale, HomeownerRequestView, HomeownerWindowInput, Quad, WindowStyle } from '@roofline/shared';
import { homeownerMeasure as copy } from '../../../copy/homeownerMeasure.ts';

/*
 * The measuring flow's state, kept apart from the screens so it can be tested: which screen, the server's view of the
 * request (the one source of truth for windows, quote and booking), and the window being measured. Screens:
 * coaching -> rooms -> measure -> describe -> windows -> quote -> contact -> book -> booked.
 */

export type Screen = 'coaching' | 'rooms' | 'measure' | 'describe' | 'windows' | 'quote' | 'contact' | 'book' | 'booked';

/** A window measured but not yet named: the proof (photo and corners) that goes with the room and style. */
export type Draft = {
  /** Made when the measuring starts, so a retry after a lost answer is the same window. */
  id: string;
  scale: HomeownerArScale | HomeownerCardScale;
  uploadId: string;
  corners: Quad;
};

export type FlowState = {
  screen: Screen;
  view: HomeownerRequestView;
  draft: Draft | null;
};

export type FlowAction =
  | { type: 'go'; screen: Screen }
  | { type: 'view'; view: HomeownerRequestView }
  | { type: 'measured'; draft: Draft }
  | { type: 'saved'; view: HomeownerRequestView }
  | { type: 'discard' };

/** Where a request that is loaded (a fresh one, or one resumed after a reload) should open. */
export function screenFor(view: HomeownerRequestView): Screen {
  if (view.request.contactFiled) return view.booking !== undefined ? 'booked' : 'book';
  if (view.request.status === 'callback') return 'coaching';
  return view.windows.length > 0 ? 'windows' : 'coaching';
}

export function startFlow(view: HomeownerRequestView): FlowState {
  return { screen: screenFor(view), view, draft: null };
}

export function flowReducer(state: FlowState, a: FlowAction): FlowState {
  switch (a.type) {
    case 'go':
      return { ...state, screen: a.screen };
    case 'view':
      return { ...state, view: a.view };
    case 'measured':
      return { ...state, draft: a.draft, screen: 'describe' };
    case 'saved':
      return { screen: 'windows', view: a.view, draft: null };
    case 'discard':
      return { ...state, draft: null, screen: 'rooms' };
  }
}

/** A new window id: letters, digits, `-`, at most 64 (what the API takes). */
export function newWindowId(random: () => string = () => globalThis.crypto.randomUUID()): string {
  return `w-${random()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export const ROOM_MAX = 40;
export const LABEL_MAX = 80;

/** The body for POST .../windows. Optional keys are left out, never null. */
export function windowInput(draft: Draft, room: string, label: string, style: WindowStyle): HomeownerWindowInput {
  const l = label.trim();
  return {
    id: draft.id,
    room: room.trim().slice(0, ROOM_MAX),
    ...(l !== '' && { label: l.slice(0, LABEL_MAX) }),
    style,
    scale: draft.scale,
    uploadId: draft.uploadId,
    corners: draft.corners,
  };
}

/** Rooms to pick from: the ones already used first, then the usual ones not used yet. */
export function roomChoices(used: readonly string[]): string[] {
  const seen = new Set(used.map((r) => r.toLowerCase()));
  return [...used, ...copy.describeRoomsCommon.filter((r) => !seen.has(r.toLowerCase()))];
}

/** Windows per room, in the order the rooms were first used. */
export function roomCounts(view: HomeownerRequestView): { room: string; count: number }[] {
  return view.rooms.map((room) => ({ room, count: view.windows.filter((w) => w.room === room).length }));
}

export type ContactForm = { firstName: string; lastName: string; email: string; phone: string; zip: string; consent: boolean };
export type ContactErrors = Partial<Record<keyof ContactForm, string>>;

/** The checks the server makes too, so most mistakes are shown before anything is sent. */
export function checkContact(f: ContactForm): ContactErrors {
  const e: ContactErrors = {};
  if (f.firstName.trim() === '') e.firstName = copy.required(copy.firstName);
  if (f.lastName.trim() === '') e.lastName = copy.required(copy.lastName);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = copy.emailInvalid;
  const digits = f.phone.replace(/\D/g, '');
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) e.phone = copy.phoneInvalid;
  if (!/^\d{5}(?:-\d{4})?$/.test(f.zip.trim())) e.zip = copy.zipInvalid;
  if (!f.consent) e.consent = copy.consentRequired;
  return e;
}

/** The ZIP at the end of an address, to start the field with. */
export const zipOf = (address: string): string => /\b(\d{5})(?:-\d{4})?\s*$/.exec(address)?.[1] ?? '';

/** Which of the four progress steps a screen is in (Measure, Price, Details, Visit). */
export function stepOf(screen: Screen): number {
  switch (screen) {
    case 'coaching':
    case 'rooms':
    case 'measure':
    case 'describe':
    case 'windows':
      return 0;
    case 'quote':
      return 1;
    case 'contact':
      return 2;
    case 'book':
    case 'booked':
      return 3;
  }
}
