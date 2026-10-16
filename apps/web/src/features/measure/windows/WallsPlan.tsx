import type { WindowMeasurementView } from '@roofline/shared';
import { measureWindows as copy } from '../../../copy/measureWindows.ts';
import styles from './WallsPlan.module.css';

/** The plan of the walls: a box as long as the front and as deep as the rest of the perimeter allows, traced by the scan. */
export function WallsPlan({ walls, drawn, floors }: { walls: NonNullable<WindowMeasurementView['walls']>; drawn: number; floors: number | null }) {
  const front = walls.frontWallFt !== null && walls.frontWallFt > 0 ? walls.frontWallFt : walls.perimeterFt / 4;
  const depth = Math.max(walls.perimeterFt / 2 - front, front * 0.3);
  const scale = 128 / Math.max(front, depth);
  const w = front * scale;
  const h = depth * scale;
  const x = (160 - w) / 2;
  const y = (144 - h) / 2;
  return (
    <div className={styles.plan} data-walls-plan="">
      <svg viewBox="0 0 160 144" width="160" height="144" role="img" aria-label={copy.wallsPlanLabel(walls.perimeterFt, walls.frontWallFt)} focusable="false">
        <rect x={x} y={y} width={w} height={h} className={styles.rect} pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1 - drawn }} />
        {/* The front wall: the side the photo looks at */}
        {drawn >= 1 ? <line x1={x} y1={y + h} x2={x + w} y2={y + h} className={styles.front} /> : null}
      </svg>
      <span className={styles.text}>
        <strong>{copy.wallsAround(walls.perimeterFt * Math.min(1, drawn))}</strong>
        {walls.frontWallFt !== null && drawn >= 1 ? <span>{copy.wallsFront(walls.frontWallFt)}</span> : null}
        {walls.wallHeightFt !== null && drawn >= 1 ? <span>{copy.wallsHigh(walls.wallHeightFt)}</span> : null}
        {floors !== null && drawn >= 1 ? <span>{copy.floors(floors)}</span> : null}
      </span>
    </div>
  );
}
