/*
 * The six dock icons: line drawings on a 24 by 24 grid, in the current text colour. They are hidden from
 * assistive technology; the dock link's label is what a person hears.
 */

export function StormIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M7 17a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.5a4 4 0 0 1 .5 7.97" />
      <path d="M12.5 11l-2.5 4h3.5l-2 4" />
    </svg>
  );
}

export function FrontDeskIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a15 15 0 0 1-7-7l2-2-2-5z" />
      <path d="M14 3a7 7 0 0 1 7 7M14 7a3 3 0 0 1 3 3" />
    </svg>
  );
}

export function EstimatorIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 7l4-4 14 14-4 4L3 7zM8 6l-2 2M11 9l-2 2M14 12l-2 2M17 15l-2 2" />
    </svg>
  );
}

export function JobsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 4v10M12 4v16M19 4v7" />
    </svg>
  );
}

export function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

export function AgentsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2 13h5l3-10 4 18 3-10 2 2h3" />
    </svg>
  );
}
