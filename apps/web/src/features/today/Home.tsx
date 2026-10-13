import { UiLink } from '@roofline/ui';
import { useState } from 'react';
import { useApprovals, useMe } from '../../api/hooks.ts';
import { home } from '../../copy/home.ts';
import { liftFeed } from '../../copy/liftFeed.ts';
import { countedDrafts } from '../../shell/countedDrafts.ts';
import { zonedDateKey } from '../calendar/time.ts';
import { useCompany } from '../settings/api.ts';
import { useStorm, useStorms } from '../storm/api.ts';
import type { StormSummary } from '../storm/types.ts';
import styles from './Home.module.css';
import { AiFeedCard } from './lift/AiFeedCard.tsx';
import { CrewWeatherCard } from './lift/CrewWeatherCard.tsx';
import { useWeatherOutlook } from './lift/liftApi.ts';
import { SignedCard } from './lift/SignedCard.tsx';
import { StormToast } from './StormToast.tsx';
import { partOfDay } from './Today.tsx';

/** The newest storm: the one whose briefing the home page tells. `day` is YYYY-MM-DD, so a text compare orders them. */
function latestStorm(storms: StormSummary[] | undefined): StormSummary | undefined {
  return storms?.reduce<StormSummary | undefined>((best, s) => (best === undefined || s.day > best.day ? s : best), undefined);
}

/**
 * The map home page's floating cards, as the reference lays them out: the greeting with a briefing built from
 * the company's own data, and Signed this month, down the left; Crew weather and What your AI just did down the
 * right; the storm toast at the top of the right column, so nothing overlaps. The map stays clickable between the cards. On a phone the cards
 * stack in one scrolling column over the map.
 */
export function Home() {
  const me = useMe();
  const company = useCompany();
  const stormsQuery = useStorms();
  const outlook = useWeatherOutlook();
  const waiting = countedDrafts(useApprovals().data).length;
  const zone = company.data?.timezone;
  const storm = latestStorm(stormsQuery.data?.storms);
  const detail = useStorm(storm?.id ?? '');

  const now = new Date();
  const [first = ''] = (me.data?.user.name ?? '').trim().split(/\s+/);
  const part = partOfDay(now, zone);
  const dateLine = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: zone }).format(now);

  const todayKey = zonedDateKey(now, zone ?? 'America/Chicago');
  const sameDay = storm?.day === todayKey;
  const when = home.stormWhen(sameDay, storm ? liftFeed.dayLong(storm.day) : '');
  const out = outlook.data?.outlook ?? null;
  const worstDay = out?.worstDate ? liftFeed.dayLong(out.worstDate) : null;
  const parts = home.briefing({
    storm: storm ? { maxIn: storm.maxIn, homesHit: storm.homesHit, when } : null,
    inspectionsBooked: storm && detail.data ? detail.data.results.inspectionsBooked : 0,
    atRisk: out?.atRisk ?? 0,
    riskDay: worstDay,
  });

  const [toastShown, setToastShown] = useState(true);
  // The toast is for a storm from today or yesterday; an older one is already in the briefing.
  const recent = storm !== undefined && Date.parse(todayKey) - Date.parse(storm.day) <= 86_400_000;

  return (
    <div className={styles.home}>
      <div className={styles.left}>
        <section className={styles.greeting} aria-labelledby="home-greeting">
          <p className={styles.date}>{dateLine}</p>
          <h2 id="home-greeting" className={styles.heading}>
            {home.greeting(part, first)}
          </h2>
          <p className={styles.briefing}>
            {parts.length === 0
              ? home.allQuiet
              : parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}
          </p>
          <div className={styles.actions}>
            {storm ? (
              <UiLink href={'/storm/' + encodeURIComponent(storm.id)} className={styles.primary}>
                {home.openStormReport}
              </UiLink>
            ) : null}
            {out && out.atRisk > 0 ? (
              <UiLink href="/calendar" className={styles.secondary}>
                {home.fixRainDay}
              </UiLink>
            ) : null}
            {waiting > 0 ? (
              <UiLink href="/approvals" className={storm ? styles.secondary : styles.primary}>
                {home.reviewApprovals(waiting)}
              </UiLink>
            ) : null}
          </div>
        </section>
        <SignedCard />
      </div>
      <div className={styles.right}>
        {storm && recent && toastShown ? <StormToast storm={storm} when={when} onDismiss={() => setToastShown(false)} /> : null}
        <CrewWeatherCard />
        <AiFeedCard />
      </div>
    </div>
  );
}
