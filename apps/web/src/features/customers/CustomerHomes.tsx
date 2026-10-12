import type { HomeSummary } from '@roofline/shared';
import { Button, Pill, useToast } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { customers } from '../../copy/customers.ts';
import { jobs } from '../../copy/jobs.ts';
import { useLocateProperty } from './api.ts';
import styles from './CustomerWindow.module.css';

export type CustomerHomesProps = { homes: HomeSummary[] };

/** "12 Oak Street, Plano, TX 75024": the street, then the city and state, then the zip. */
export function formatHomeAddress(home: Pick<HomeSummary, 'addressLine' | 'city' | 'state' | 'zip'>): string {
  const cityState = [home.city, home.state].filter((part) => part !== '').join(', ');
  const cityLine = [cityState, home.zip].filter((part) => part !== '').join(' ');
  return [home.addressLine, cityLine].filter((part) => part !== '').join(', ');
}

/** The customer's homes: each with its address, its jobs as stage chips, and Place on map when the server has not placed it. */
export function CustomerHomes({ homes }: CustomerHomesProps) {
  if (homes.length === 0) return <p className={styles.muted}>{customers.window.noHomes}</p>;

  return (
    <ul className={styles.homeList}>
      {homes.map((home) => (
        <li key={home.id}>
          <HomeRow home={home} />
        </li>
      ))}
    </ul>
  );
}

function HomeRow({ home }: { home: HomeSummary }) {
  const toast = useToast();
  const locate = useLocateProperty();

  function placeOnMap() {
    locate.mutate(home.id, {
      onSuccess: () => toast.show(customers.window.placedToast, 'success'),
      onError: (error) => toast.show(error instanceof ApiError ? error.message : customers.window.placeFailed, 'error'),
    });
  }

  return (
    <div className={styles.home} data-located={home.located ? 'true' : 'false'}>
      <p className={styles.address}>{formatHomeAddress(home)}</p>
      {home.jobs.length === 0 ? null : (
        <ul className={styles.list}>
          {home.jobs.map((job) => (
            <li key={job.id}>
              <Pill tone="neutral" href={`/jobs/${job.id}`}>
                {jobs.stage[job.stage]}
              </Pill>
            </li>
          ))}
        </ul>
      )}
      {home.located ? null : (
        <div className={styles.item}>
          <span className={styles.muted}>{customers.window.notOnMap}</span>
          <Button variant="ghost" busy={locate.isPending} onClick={placeOnMap}>
            {locate.isPending ? customers.window.placing : customers.window.placeOnMap}
          </Button>
        </div>
      )}
    </div>
  );
}
