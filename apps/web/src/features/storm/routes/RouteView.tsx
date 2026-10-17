import { Button, EmptyState, Icon, Panel, ProgressBar, Skeleton, Tag } from '@roofline/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { doors } from '../../../copy/doors.ts';
import { storm } from '../../../copy/storm.ts';
import { AppPage } from '../../../shell/AppPage.tsx';
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

/** The page while a route loads or cannot be read: the same head and trail, then the message. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <AppPage
      app="storm"
      subtitle={false}
      crumbs={[{ label: storm.crumbStorm, href: '/storm' }, { label: doors.myRoutesLink, href: '/storm/routes' }]}
    >
      {children}
    </AppPage>
  );
}

/**
 * One route, thumb first: on a phone the door to knock now comes first (the address, Navigate, the outcome buttons),
 * then the map, then every door in order. On a desktop the map is at the left and the doors at the right.
 */
export function RouteView({ routeId }: { routeId: string }) {
  const query = useRoute(routeId);
  const position = useRepPosition();
  const data = query.data;
  const stops = useMemo(() => (data ? [...data.stops].sort((a, b) => a.position - b.position) : []), [data]);

  if (query.isPending) {
    return (
      <Shell>
        <div role="status" aria-label={doors.routeLoading} className={styles.loading}>
          <Skeleton lines={4} />
        </div>
      </Shell>
    );
  }

  if (query.isError) {
    return (
      <Shell>
        <EmptyState title={doors.routeError} />
      </Shell>
    );
  }

  const { route } = query.data;
  const currentIndex = stops.findIndex((stop) => stop.outcome === null);
  const currentStop: DoorStop | undefined = currentIndex === -1 ? undefined : stops[currentIndex];
  const ios = isIos(navigator.userAgent);
  const progress = doors.progress(route.doneStops, route.stops);

  return (
    <AppPage
      app="storm"
      heading={route.name}
      eyebrow={doors.routeEyebrow}
      subtitle={progress}
      crumbs={[
        { label: storm.crumbStorm, href: '/storm' },
        { label: doors.myRoutesLink, href: '/storm/routes' },
        { label: route.name },
      ]}
    >
      <div className={styles.view}>
        <div className={styles.map}>
          <RouteMap stops={stops} currentStopId={currentStop?.id ?? null} position={position} />
        </div>
        <div className={styles.side}>
          {currentStop ? (
            <Panel title={doors.doorOf(currentIndex + 1, stops.length)} className={styles.current}>
              <div className={styles.door}>
                <p className={styles.address}>{currentStop.address ?? doors.noAddress}</p>
                {currentStop.hailIn !== null ? <p className={styles.hail}>{doors.hailLine(currentStop.hailIn)}</p> : null}
                <Button variant="default" size="lg" className={styles.navigate} href={navigateUrl(currentStop, ios)} {...NEW_TAB}>
                  <Icon name="route" size={16} />
                  {doors.navigate}
                </Button>
                <DoorOutcome routeId={routeId} stop={currentStop} />
              </div>
            </Panel>
          ) : (
            <EmptyState
              title={doors.routeDone}
              action={
                <Button variant="default" href="/storm/routes">
                  {doors.backToRoutes}
                </Button>
              }
            />
          )}
          <Panel title={doors.stopsHeading} tag={progress} padded={false} className={styles.doors}>
            <div className={styles.bar}>
              <ProgressBar value={route.doneStops} max={route.stops} label={progress} />
            </div>
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
                    <span className={styles.stopAddress}>{stop.address ?? doors.noAddress}</span>
                    {stop.outcome !== null ? (
                      <Tag tone="ok" icon="check">
                        {doors.doneMark}
                      </Tag>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </Panel>
        </div>
      </div>
    </AppPage>
  );
}
