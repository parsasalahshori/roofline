import { lazy, Suspense, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useMe } from '../api/hooks.ts';
import styles from './MapPanel.module.css';
import { MapErrorBoundary } from './map/MapErrorBoundary.tsx';

// The map (MapLibre, about 1 MB) loads in its own chunk, after the shell has rendered
const MapView = lazy(() => import('./map/MapView.tsx').then((m) => ({ default: m.MapView })));

/**
 * The map, framed as a panel. Home and Storm hold it; no other page has a map behind it. It fills whatever box its
 * parent gives it (a height or a flex share). Overlays (the storm callout) are its children and sit over the map.
 * `pins` says whether the Jobs layer starts on: Home shows everything, Storm starts on the hail alone.
 */
export function MapPanel({ children, pins }: { children?: ReactNode; pins?: boolean }) {
  const me = useMe();
  const navigate = useNavigate();
  const companyId = me.data?.company.id ?? 'none';
  // Starting an estimate from a roof on the map is for owner and office; reps get no roof card.
  const canEstimateRoof = me.data?.role === 'owner' || me.data?.role === 'office';

  return (
    <div className={styles.panel}>
      {/* Keyed by company: a switch remounts the map (no old pins or pin card) and clears a failed map */}
      <MapErrorBoundary key={companyId}>
        <Suspense fallback={<div className={styles.loading} aria-hidden="true" />}>
          <MapView
            {...(pins !== undefined && { pins })}
            onOpen={(target) => void navigate((target.kind === 'customer' ? '/customers/' : '/jobs/') + encodeURIComponent(target.id))}
            onEstimate={
              canEstimateRoof
                ? // Estimate this roof was the press: the scan plays as soon as the roof opens
                  (measurementId) => void navigate(`/estimator/measure/${encodeURIComponent(measurementId)}`, { state: { autoScan: true } })
                : undefined
            }
          />
        </Suspense>
      </MapErrorBoundary>
      {children ? <div className={styles.overlay}>{children}</div> : null}
    </div>
  );
}
