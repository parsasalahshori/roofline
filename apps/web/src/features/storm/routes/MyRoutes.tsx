import { Button, EmptyState, ProgressBar, Skeleton, Tag, type IconName, type TagTone } from '@roofline/ui';
import { Link } from 'react-router';
import { doors } from '../../../copy/doors.ts';
import { useMyRoutes } from './api.ts';
import styles from './MyRoutes.module.css';
import type { DoorRouteStatus, RouteSummary } from './types.ts';

/** A route's state as a tag: ready is the company's colour, started is blue, done is green; each has its glyph. */
const STATUS_TAG: Record<DoorRouteStatus, { tone: TagTone; icon: IconName }> = {
  ready: { tone: 'brand', icon: 'route' },
  in_progress: { tone: 'info', icon: 'refresh' },
  done: { tone: 'ok', icon: 'check' },
};

/** One route as a card: the whole card is the link, a 56px-tall target. Owner names are never shown. */
function RouteCard({ route }: { route: RouteSummary }) {
  const progress = doors.progress(route.doneStops, route.stops);
  const tag = STATUS_TAG[route.status];
  return (
    <li className={styles.item}>
      <Link
        to={`/storm/routes/${route.id}`}
        aria-label={doors.routeLinkLabel(route.name, route.doneStops, route.stops)}
        className={styles.card}
      >
        <span className={styles.top}>
          <span className={styles.name}>{route.name}</span>
          <Tag tone={tag.tone} icon={tag.icon}>
            {doors.routeStatus[route.status]}
          </Tag>
        </span>
        <span className={styles.progress}>{progress}</span>
        <ProgressBar value={route.doneStops} max={route.stops} label={progress} />
      </Link>
    </li>
  );
}

/** The rep's door-knocking routes, one card each. */
export function MyRoutes() {
  const query = useMyRoutes();

  if (query.isPending) {
    return (
      <div role="status" aria-label={doors.myRoutesLoading} className={styles.loading}>
        <Skeleton lines={3} />
      </div>
    );
  }

  if (query.isError) {
    return <EmptyState title={doors.myRoutesError} />;
  }

  const routes = query.data.routes;
  if (routes.length === 0) {
    return (
      <EmptyState
        title={doors.myRoutesEmpty}
        action={
          <Button variant="default" href="/storm">
            {doors.backToStorm}
          </Button>
        }
      />
    );
  }

  return (
    <ul className={styles.list}>
      {routes.map((route) => (
        <RouteCard key={route.id} route={route} />
      ))}
    </ul>
  );
}
