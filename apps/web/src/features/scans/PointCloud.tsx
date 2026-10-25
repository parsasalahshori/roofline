import type { ScanCloudView } from '@roofline/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiFetch } from '../../api/client.ts';
import { scanReview } from '../../copy/scanReview.ts';
import apple from './apple.module.css';
import { type CloudPoint, type CloudScene, type CloudView, CLOUD_VIEWS, cloudPoints, cloudUv, fitCloud, scaleBar, toPanel } from './cloudGeometry.ts';
import styles from './PointCloud.module.css';

const W = 360;
const H = 240;

/** GET the aligned COLMAP points (behind the session). */
export function useCloud(url: string | null) {
  return useQuery({
    queryKey: ['window-scans', 'cloud', url],
    enabled: url !== null,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<CloudPoint[]> => cloudPoints((await apiFetch<ScanCloudView>(url!, { signal })).points),
  });
}

function Panel({ view, points, scene }: { view: CloudView; points: readonly CloudPoint[]; scene: CloudScene }) {
  const geo = useMemo(() => {
    const uv = points.map((p) => cloudUv(view, [p.x, p.y, p.z]));
    const corners = scene.corners.map((p) => cloudUv(view, p));
    const cameras = scene.cameras.map((c) => ({ uv: cloudUv(view, c.p), colmap: c.colmap }));
    const fit = fitCloud(uv, [...corners, ...cameras.map((c) => c.uv)], W, H);
    return { uv, corners, cameras, fit };
  }, [view, points, scene]);
  const { fit } = geo;
  const bar = scaleBar(fit.scale);
  const label = view === 'top' ? scanReview.cloudTop : scanReview.cloudSide;
  // The window's outline: the four corners in order, closed
  const outline = geo.corners.length === 4 ? geo.corners.map((c) => toPanel(fit, c).join(',')).join(' ') : null;
  return (
    <figure className={styles.panel}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label={scanReview.cloudLabel(label)}>
        {points.map((p, i) => {
          const [x, y] = toPanel(fit, geo.uv[i]!);
          return <circle key={i} cx={x} cy={y} r={1.15} fill={`rgb(${p.r},${p.g},${p.b})`} opacity={0.85} />;
        })}
        {outline !== null ? <polygon points={outline} className={styles.outline} /> : null}
        {geo.corners.map((c, i) => {
          const [x, y] = toPanel(fit, c);
          return <polygon key={`c${i}`} points={`${x},${y - 5} ${x + 5},${y} ${x},${y + 5} ${x - 5},${y}`} className={styles.corner} />;
        })}
        {geo.cameras.map((c, i) => {
          const [x, y] = toPanel(fit, c.uv);
          return <rect key={`m${i}`} x={x - 3.5} y={y - 3.5} width={7} height={7} rx={2} className={styles.camera} data-colmap={c.colmap ? 'true' : undefined} />;
        })}
        <line x1={14} x2={14 + bar.px} y1={H - 14} y2={H - 14} className={styles.bar} />
        <text x={14 + bar.px + 6} y={H - 10} className={styles.barText}>
          {scanReview.cloudScale(bar.metres)}
        </text>
      </svg>
      <figcaption className={styles.caption}>{label}</figcaption>
    </figure>
  );
}

/** The 3D rebuild as two plain scatters (from above and from the side) with the window's corners and the cameras on them. */
export function PointCloud({ url, scene, count }: { url: string; scene: CloudScene; count: number }) {
  const cloud = useCloud(url);
  return (
    <section className={styles.section} aria-label={scanReview.cloudTitle}>
      <div className={styles.head}>
        <h3>{scanReview.cloudTitle}</h3>
        <span className={styles.note}>{scanReview.cloudBody(count)}</span>
      </div>
      {cloud.isPending ? (
        <p className={styles.state} role="status">
          {scanReview.cloudLoading}
        </p>
      ) : cloud.isError || cloud.data.length === 0 ? (
        <p className={styles.state} role="alert">
          {cloud.isError ? scanReview.cloudFailed : scanReview.cloudNone}
        </p>
      ) : (
        <div className={styles.panels}>
          {CLOUD_VIEWS.map((v) => (
            <Panel key={v} view={v} points={cloud.data} scene={scene} />
          ))}
        </div>
      )}
      <ul className={`${apple.legendInline} ${styles.legend}`}>
        <li>
          <span className={styles.keyPoint} aria-hidden="true" />
          {scanReview.cloudLegend.points}
        </li>
        <li>
          <span className={styles.keyCorner} aria-hidden="true" />
          {scanReview.cloudLegend.corners}
        </li>
        <li>
          <span className={styles.keyCamera} aria-hidden="true" />
          {scanReview.cloudLegend.cameras}
        </li>
      </ul>
    </section>
  );
}
