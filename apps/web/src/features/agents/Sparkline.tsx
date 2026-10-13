import { useId } from 'react';
import styles from './Sparkline.module.css';

export type SparklineProps = {
  values: number[];
  label: string;
  width: number;
  height: number;
  /** Faint guide lines across the plot (the big tile). */
  grid?: boolean;
  /** Print the last value beside the end dot (the big tile). */
  endLabel?: boolean;
};

/** A line with a soft area under it and a dot on the last point. Drawn with our own SVG; no chart library. */
export function Sparkline({ values, label, width, height, grid = false, endLabel = false }: SparklineProps) {
  const id = useId();
  const padX = 3;
  const padTop = 5;
  const padBottom = 3;
  const labelRoom = endLabel ? 34 : 0;
  const plotW = width - padX * 2 - labelRoom;
  const plotH = height - padTop - padBottom;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? plotW / (values.length - 1) : 0;
  const points = values.map((v, i) => ({ x: padX + i * step, y: padTop + plotH - (v / max) * plotH }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const first = points[0];
  const area = last && first ? `${line} L${last.x.toFixed(1)} ${padTop + plotH} L${first.x.toFixed(1)} ${padTop + plotH} Z` : '';
  const lastValue = values[values.length - 1] ?? 0;
  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label={`${label}: ${values.join(', ')}`}
    >
      <title id={`${id}-t`}>{label}</title>
      {grid
        ? [0, 0.5, 1].map((f) => (
            <line key={f} className={styles.grid} x1={padX} x2={padX + plotW} y1={padTop + plotH * f} y2={padTop + plotH * f} />
          ))
        : null}
      {area ? <path className={styles.area} d={area} /> : null}
      <path className={styles.line} d={line} vectorEffect="non-scaling-stroke" />
      {last ? <circle className={styles.dot} cx={last.x} cy={last.y} r={3} /> : null}
      {endLabel && last ? (
        <text className={styles.endLabel} x={last.x + 9} y={last.y + 4}>
          {lastValue}
        </text>
      ) : null}
    </svg>
  );
}
