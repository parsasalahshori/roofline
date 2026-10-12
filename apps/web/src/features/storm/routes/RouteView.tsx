import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { useEffect, useMemo, useState } from 'react';
import { doors } from '../../../copy/doors.ts';
import { DoorOutcome } from './DoorOutcome.tsx';
import { useRoute } from './api.ts';
import { isIos, navigateUrl } from './navigate.ts';
import { RouteMap } from './RouteMap.tsx';
import styles from './RouteView.module.css';
import type { DoorStop } from './types.ts';

type Position = { lat: number; lng: number };

/** The directions link opens in a new tab. Button's own type has no target, so these go on as a spread. */
const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' };

/** The rep's position from the browser, while the browser allows it. Nothing is shown when it does not. */
function useRepPosition(): Position | null {
  const [position, setPosition] = useState<Position | null>(null);
  useEffect(() => {
    const geolocation: Geolocation | undefined = navigator.geolocation;
    if (!geolocation) return;
    const id = geolocation.watchPosition(
      (fix) => setPosition({ lat: fix.coords.latitude, lng: fix.coords.longitude }),
      () => {},
    );
    return () => {
      geolocation.clearWatch(id);
    };
  }, []);
  return position;
}

/** One route on the phone: the map, the door to knock now, and every door in order. */
export function RouteView({ routeId }: { routeId: string }) {
  const query = useRoute(routeId);
  const position = useRepPosition();
  const data = query.data;
  const stops = useMemo(() => (data ? [...data.stops].sort((a, b) => a.position - b.position) : []), [data]);

  if (query.isPending) {
    return (
      <div role="status" aria-label={doors.routeLoading} className={styles.loading}>
        <Skeleton lines={4} />
      </div>
    );
  }

  if (query.isError) {
    return <EmptyState title={doors.routeError} />;
  }

  const { route } = query.data;
  const currentIndex = stops.findIndex((stop) => stop.outcome === null);
  const currentStop: DoorStop | undefined = currentIndex === -1 ? undefined : stops[currentIndex];
  const ios = isIos(navigator.userAgent);

  return (
    <div className={styles.view}>
      <h2 className={styles.heading}>{route.name}</h2>
      <RouteMap stops={stops} currentStopId={currentStop?.id ?? null} position={position} />

      {currentStop ? (
        <section className={styles.current} aria-label={doors.doorOf(currentIndex + 1, stops.length)}>
          <p className={styles.doorLabel}>{doors.doorOf(currentIndex + 1, stops.length)}</p>
          <p className={styles.address}>{currentStop.address}</p>
          <p className={styles.hail}>{doors.hailLine(currentStop.hailIn)}</p>
          <Button variant="ghost" className={styles.navigate} href={navigateUrl(currentStop, ios)} {...NEW_TAB}>
            {doors.navigate}
          </Button>
          <DoorOutcome routeId={routeId} stop={currentStop} />
        </section>
      ) : (
        <EmptyState
          title={doors.routeDone}
          action={
            <Button variant="ghost" href="/storm/routes">
              {doors.backToRoutes}
            </Button>
          }
        />
      )}

      <h3 className={styles.listHeading}>{doors.stopsHeading}</h3>
      <ol className={styles.list}>
        {stops.map((stop, index) => {
          const isCurrent = stop.id === currentStop?.id;
          return (
            <li
              key={stop.id}
              className={styles.item}
              data-current={isCurrent ? '' : undefined}
              data-done={stop.outcome !== null ? '' : undefined}
            >
              <span className={styles.number}>{index + 1}</span>
              <span className={styles.stopAddress}>{stop.address}</span>
              {stop.outcome !== null ? <span className={styles.doneMark}>{doors.doneMark}</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
