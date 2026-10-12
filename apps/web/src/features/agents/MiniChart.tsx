import type { DayCount } from '@roofline/shared';
import { agentsWindow } from '../../copy/agents.ts';
import styles from './MiniChart.module.css';

const WIDTH = 140;
const HEIGHT = 40;
const GAP = 2;

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** 'Oct 12' from a 'YYYY-MM-DD' string, with no time zone shifting. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return DAY.format(new Date(Date.UTC(y, m - 1, d)));
}

/** Tiny SVG bar chart (hidden from assistive tech) plus a visually hidden table that carries the data. */
export function MiniChart({ days, label }: { days: DayCount[]; label: string }) {
  const max = Math.max(1, ...days.map((d) => d.finished));
  const slot = days.length > 0 ? WIDTH / days.length : WIDTH;
  const barWidth = Math.max(1, slot - GAP);
  return (
    <div className={styles.wrap}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        width="100%"
        aria-hidden="true"
        focusable="false"
      >
        {days.map((d, i) => {
          const h = d.finished > 0 ? Math.max(1, (d.finished / max) * HEIGHT) : 1;
          return (
            <rect
              key={d.date}
              className={styles.bar}
              data-finished={d.finished}
              x={i * slot + GAP / 2}
              y={HEIGHT - h}
              width={barWidth}
              height={h}
            />
          );
        })}
      </svg>
      <table className={styles.srOnly}>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{agentsWindow.chartDate}</th>
            <th scope="col">{agentsWindow.chartFinished}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>{dayLabel(d.date)}</td>
              <td>{d.finished}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
