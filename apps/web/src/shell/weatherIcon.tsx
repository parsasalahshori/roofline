import type { ReactNode } from 'react';
import type { CurrentWeather } from '../api/types.ts';

/*
 * The weather icons Home's crew card draws: inline svg, paths only. The words come from the copy beside them.
 */

/** The shape of each kind of weather, drawn inside the 24 by 24 box of the icon. */
const WEATHER_SHAPES: Record<CurrentWeather['icon'], ReactNode> = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  cloud: <path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9a4.5 4.5 0 0 1 0 9H7z" />,
  rain: (
    <>
      <path d="M7 15a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 6.5a4.5 4.5 0 0 1 0 8.5H7z" />
      <path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3" />
    </>
  ),
  storm: (
    <>
      <path d="M7 15a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 6.5a4.5 4.5 0 0 1 .5 8.47" />
      <path d="M12.5 12l-2.5 4h3.5l-2 4" />
    </>
  ),
  snow: (
    <>
      <path d="M7 15a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 6.5a4.5 4.5 0 0 1 0 8.5H7z" />
      <path d="M8 18.5h.01M12 19.5h.01M16 18.5h.01" />
    </>
  ),
  fog: <path d="M4 9h16M6 13h12M4 17h16" />,
  wind: <path d="M3 9h10a2.5 2.5 0 1 0-2.5-2.5M3 13h14a2.5 2.5 0 1 1-2.5 2.5M3 17h7" />,
};

/** The icon for the weather now: one of the eight kinds the server sends. */
export function WeatherIcon({ icon }: { icon: CurrentWeather['icon'] }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {WEATHER_SHAPES[icon]}
    </svg>
  );
}
