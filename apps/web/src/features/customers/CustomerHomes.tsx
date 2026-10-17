import type { HomeSummary } from '@roofline/shared';
import { Button, Icon, Panel, UiLink, useToast } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { customers } from '../../copy/customers.ts';
import { EmptyPanel } from '../jobs/states.tsx';
import { StageTag } from '../jobs/StageTag.tsx';
import { useLocateProperty } from './api.ts';
import styles from './CustomerWindow.module.css';

export type CustomerHomesProps = { homes: HomeSummary[]; addHomeHref: string };

/** "12 Oak Street, Plano, TX 75024": the street, then the city and state, then the zip. */
export function formatHomeAddress(home: Pick<HomeSummary, 'addressLine' | 'city' | 'state' | 'zip'>): string {
  const cityState = [home.city, home.state].filter((part) => part !== '').join(', ');
  const cityLine = [cityState, home.zip].filter((part) => part !== '').join(' ');
  return [home.addressLine, cityLine].filter((part) => part !== '').join(', ');
}

/** The customer's homes: each with its address, its jobs as stage tags, and Place on map when the server has not placed it. */
export function CustomerHomes({ homes, addHomeHref }: CustomerHomesProps) {
  return (
    <Panel
      title={customers.window.homesHeading}
      className={styles.homes}
      actions={
        <Button href={addHomeHref} variant="default" size="sm">
          <Icon name="plus" size={16} />
          {customers.window.addHome}
        </Button>
      }
    >
      {homes.length === 0 ? (
        <EmptyPanel variant="inline" title={customers.window.noHomes} body={customers.window.noHomesBody} ghost="rows" />
      ) : (
        <ul className={styles.rows}>
          {homes.map((home) => (
            <li key={home.id}>
              <HomeRow home={home} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
        <ul className={styles.tagList}>
          {home.jobs.map((job) => (
            <li key={job.id}>
              <UiLink href={`/jobs/${job.id}`} className={styles.stageLink}>
                <StageTag stage={job.stage} />
              </UiLink>
            </li>
          ))}
        </ul>
      )}
      {home.located ? null : (
        <div className={styles.notOnMap}>
          <span className={styles.muted}>{customers.window.notOnMap}</span>
          <Button variant="default" size="sm" busy={locate.isPending} onClick={placeOnMap}>
            <Icon name="pin" size={16} />
            {locate.isPending ? customers.window.placing : customers.window.placeOnMap}
          </Button>
        </div>
      )}
    </div>
  );
}
