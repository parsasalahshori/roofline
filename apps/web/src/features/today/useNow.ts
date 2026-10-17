import { useEffect, useState } from 'react';

/** The current time in milliseconds, read again every `everyMs` (a minute by default), so "3 min ago" stays true on a page left open. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
