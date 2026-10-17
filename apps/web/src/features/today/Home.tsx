import { Button, Icon } from '@roofline/ui';
import { useApprovals, useMe } from '../../api/hooks.ts';
import { home } from '../../copy/home.ts';
import { shell } from '../../copy/shell.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { countedDrafts } from '../../shell/countedDrafts.ts';
import { MapPanel } from '../../shell/MapPanel.tsx';
import { useCompany } from '../settings/api.ts';
import styles from './Home.module.css';
import { HomeApproval } from './HomeApproval.tsx';
import { newestFirst, partOfDay } from './homeFacts.ts';
import { HomeKpis } from './HomeKpis.tsx';
import { HomeToday } from './HomeToday.tsx';
import { AiFeedCard } from './lift/AiFeedCard.tsx';
import { CrewWeatherCard } from './lift/CrewWeatherCard.tsx';
import { StormCallout } from './StormCallout.tsx';
import { useMoreBelow } from './useMoreBelow.ts';

/**
 * Home on a desktop: the greeting and the two things to start (measure an address, a new job), the strip of four
 * numbers, then the map with the storm note on it at the left and a column at the right: the plan waiting for a yes,
 * today's visits, the crew's weather and what the agents did. A rep sees no plans (those are for the owner and office).
 */
export function Home() {
  const me = useMe();
  const company = useCompany();
  const approvals = useApprovals();
  const canDecide = me.data?.role === 'owner' || me.data?.role === 'office';
  const drafts = canDecide ? newestFirst(countedDrafts(approvals.data)) : [];
  const [newest] = drafts;
  const [columnRef, moreBelow] = useMoreBelow<HTMLDivElement>();

  const now = new Date();
  const zone = company.data?.timezone;
  const [first = ''] = (me.data?.user.name ?? '').trim().split(/\s+/);
  const dateLine = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: zone }).format(now);

  return (
    <AppPage
      app="home"
      heading={home.greeting(partOfDay(now, zone), first)}
      eyebrow={dateLine}
      subtitle={false}
      crumbs={[{ label: shell.crumbHome }]}
      actions={
        <>
          <Button variant="default" href="/estimator">
            <Icon name="ruler" size={16} />
            {home.measureAddress}
          </Button>
          <Button variant="primary" href="/jobs/new">
            <Icon name="plus" size={16} />
            {home.newJob}
          </Button>
        </>
      }
      stats={<HomeKpis />}
      layout="fill"
    >
      <div className={styles.grid}>
        <div className={styles.map}>
          <MapPanel>
            <StormCallout />
          </MapPanel>
        </div>
        <div ref={columnRef} className={styles.column} data-more={moreBelow ? 'true' : undefined}>
          {newest ? <HomeApproval key={newest.id} task={newest} more={drafts.length - 1} /> : null}
          <HomeToday />
          <CrewWeatherCard />
          <AiFeedCard />
        </div>
      </div>
    </AppPage>
  );
}
