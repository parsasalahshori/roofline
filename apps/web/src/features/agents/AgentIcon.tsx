import type { ScreenAgent } from '@roofline/shared';
import type { ReactNode } from 'react';

/** Our own line icons, one per agent. Drawn on a 24 by 24 grid in the current text color. */
export const AGENT_GLYPH: Record<ScreenAgent, ReactNode> = {
  storm_scout: (
    <>
      <path d="M7 14.5a3.8 3.8 0 0 1 .4-7.6A5 5 0 0 1 17 7.6a3.5 3.5 0 0 1 .4 6.9H7z" />
      <circle cx="8.5" cy="18.2" r="0.9" />
      <circle cx="12" cy="19.6" r="0.9" />
      <circle cx="15.5" cy="18.2" r="0.9" />
    </>
  ),
  front_desk: (
    <path d="M6.6 3.6l2.3.4.9 3.3-1.7 1.3a11 11 0 0 0 5.5 5.5l1.3-1.7 3.3.9.4 2.3a2 2 0 0 1-2 2.2A14.6 14.6 0 0 1 4.4 5.6a2 2 0 0 1 2.2-2z" />
  ),
  estimator: (
    <>
      <rect x="2.5" y="9" width="19" height="6" rx="1.4" transform="rotate(-45 12 12)" />
      <path d="M9.2 9.9l1.4 1.4M11.6 7.5L13 8.9M6.8 12.3l1.4 1.4" />
    </>
  ),
  claims: (
    <>
      <path d="M12 3l7 3v5.2c0 4.3-2.9 7.8-7 9.8-4.1-2-7-5.5-7-9.8V6l7-3z" />
      <path d="M8.8 12l2.3 2.3L15.4 10" />
    </>
  ),
  scheduler: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.2" />
      <path d="M4 10h16M8.2 3.5v4M15.8 3.5v4" />
      <path d="M8 13.5h2M12 13.5h2M8 16.5h2" />
    </>
  ),
  follow_up: <path d="M4.5 5.5h15v10.5h-9.5l-5 3.8V5.5z" />,
};

export function AgentIcon({ agent, size = 22 }: { agent: ScreenAgent; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {AGENT_GLYPH[agent]}
    </svg>
  );
}
