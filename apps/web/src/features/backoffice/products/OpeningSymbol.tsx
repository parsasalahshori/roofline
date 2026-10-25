import type { OpeningKind } from '@roofline/shared';

/** A small drawing of how a section opens, seen from outside: the frame, and a mark for the hinge or the slide. */
export function OpeningSymbol({ kind }: { kind: OpeningKind }) {
  const arrows: Partial<Record<OpeningKind, string>> = {
    'slide-left': 'M15 8H5M8 5L5 8l3 3',
    'slide-right': 'M5 8h10M12 5l3 3-3 3',
    'door-slide-left': 'M15 8H5M8 5L5 8l3 3',
    'door-slide-right': 'M5 8h10M12 5l3 3-3 3',
  };
  const hinge: Partial<Record<OpeningKind, string>> = {
    'casement-left': 'M18 2L3 8l15 6',
    'casement-right': 'M2 2l15 6L2 14',
    awning: 'M2 14L10 3l8 11',
    hopper: 'M2 2l8 11 8-11',
  };
  const path = arrows[kind] ?? hinge[kind];
  return (
    <svg viewBox="0 0 20 16" width={24} height={20} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="18" height="14" rx="1" />
      {kind === 'hung-sash' ? <path d="M1 8h18" /> : null}
      {kind === 'fixed' || kind === 'door-fixed' ? <path d="M4 5l3-1M4 8l6-3" opacity={0.6} /> : null}
      {path ? <path d={path} strokeDasharray={kind.startsWith('slide') || kind.startsWith('door-slide') ? undefined : '2 2'} /> : null}
    </svg>
  );
}
