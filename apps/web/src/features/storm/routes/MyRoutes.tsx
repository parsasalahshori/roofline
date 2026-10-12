import { EmptyState, ProgressBar, Skeleton } from '@roofline/ui';
import { Link } from 'react-router';
import { doors } from '../../../copy/doors.ts';
import { useMyRoutes } from './api.ts';
import styles from './MyRoutes.module.css';
import type { RouteSummary } from './types.ts';

/** One route as a card: the whole card is the link, a 56px-tall target. Owner names are never shown. */
function RouteCard({ route }: { route: RouteSummary }) {
  const progress = doors.progress(route.doneCount, route.stopCount);
  return (
    <li className={styles.item}>
      <Link
        to={`/storm/routes/${route.id}`}
        aria-label={doors.routeLinkLabel(route.name, route.doneCount, route.stopCount)}
        className={styles.card}
      >
        <span className={styles.top}>
          <span className={styles.name}>{route.name}</span>
          <span className={styles.status} data-status={route.status}>
            {doors.routeStatus[route.status]}
          </span>
        </span>
        <span className={styles.progress}>{progress}</span>
        <ProgressBar value={route.doneCount} max={route.stopCount} label={progress} />
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
    return <EmptyState title={doors.myRoutesEmpty} />;
  }

  return (
    <ul className={styles.list}>
      {routes.map((route) => (
        <RouteCard key={route.id} route={route} />
      ))}
    </ul>
  );
}
