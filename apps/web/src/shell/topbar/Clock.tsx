import { useEffect, useState } from 'react';
import { shell } from '../../copy/shell.ts';
import styles from './Clock.module.css';

/** The date and time in the top bar. It moves on every 20 seconds, which is enough for a minute display. */
export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time dateTime={now.toISOString()} className={styles.clock}>
      {shell.dateTime(now)}
    </time>
  );
}
