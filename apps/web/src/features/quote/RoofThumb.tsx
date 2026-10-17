import type { LngLat } from '@roofline/shared';
import { useState, type ReactNode } from 'react';
import styles from './RoofThumb.module.css';

/*
 * The home from above with its measured outline: a few satellite tiles laid out in Web Mercator and an SVG ring on
 * top. No map library: a handful of <img> tiles is all a phone on 4G has to load. The tiles are the free aerial
 * imagery the app's demo build uses (allowed by the app's Content-Security-Policy); the credit line sits under it.
 */

const W = 360;
const H = 240;
const TILE = 256;
/** 19: the free aerial has gaps at 20 in many places. */
const MAX_ZOOM = 19;
const FILL = 0.55;
const TILE_URL = (z: number, x: number, y: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

function project([lng, lat]: LngLat, z: number): [number, number] {
  const scale = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * scale, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale];
}

export type ThumbLayout = {
  tiles: { key: string; src: string; left: number; top: number }[];
  points: [number, number][];
};

/** Where the tiles and the outline's corners go in a W x H box, as percentages. Exported for the tests. */
export function thumbLayout(ring: readonly LngLat[], center: LngLat): ThumbLayout {
  let z = MAX_ZOOM;
  for (; z > 15; z--) {
    const pts = ring.map((p) => project(p, z));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) <= W * FILL && Math.max(...ys) - Math.min(...ys) <= H * FILL) break;
  }
  const pts = ring.map((p) => project(p, z));
  const mid: [number, number] =
    pts.length > 0
      ? [(Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2, (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2]
      : project(center, z);
  const x0 = mid[0] - W / 2;
  const y0 = mid[1] - H / 2;
  const tiles: ThumbLayout['tiles'] = [];
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + W) / TILE); tx++) {
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + H) / TILE); ty++) {
      tiles.push({ key: `${z}/${tx}/${ty}`, src: TILE_URL(z, tx, ty), left: ((tx * TILE - x0) / W) * 100, top: ((ty * TILE - y0) / H) * 100 });
    }
  }
  return { tiles, points: pts.map(([x, y]) => [((x - x0) / W) * 100, ((y - y0) / H) * 100]) };
}

/** The photo's stand-in before the answer is in (the scan's guides are drawn over it). */
export function RoofThumbPlaceholder({ children }: { children?: ReactNode }) {
  return <div className={styles.placeholder}>{children}</div>;
}

/**
 * The photo. Until every tile has come in (or failed) the box shows a soft moving placeholder instead of a blank,
 * and each tile fades in as it lands: the free imagery can take a few seconds on a phone.
 */
export function RoofThumb({ ring, center, alt, showOutline, children }: { ring: readonly LngLat[]; center: LngLat; alt: string; showOutline: boolean; children?: ReactNode }) {
  const layout = thumbLayout(ring, center);
  const polygon = layout.points.map(([x, y]) => `${(x / 100) * W},${(y / 100) * H}`).join(' ');
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const settle = (key: string) => setSettled((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  const loading = layout.tiles.some((t) => !settled.has(t.key));
  return (
    <div className={styles.thumb} role="img" aria-label={alt} data-loading={loading ? true : undefined}>
      {layout.tiles.map((t) => (
        <img
          key={t.key}
          src={t.src}
          alt=""
          className={styles.tile}
          style={{ left: `${t.left}%`, top: `${t.top}%`, width: `${(TILE / W) * 100}%`, height: `${(TILE / H) * 100}%` }}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          data-loaded={settled.has(t.key) ? true : undefined}
          onLoad={() => settle(t.key)}
          onError={(e) => {
            e.currentTarget.style.visibility = 'hidden';
            settle(t.key);
          }}
        />
      ))}
      {showOutline && layout.points.length >= 3 ? (
        <svg className={styles.outline} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <polygon points={polygon} />
        </svg>
      ) : null}
      {children}
    </div>
  );
}
