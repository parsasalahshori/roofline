import { Button, Icon, IconButton } from '@roofline/ui';
import { useState } from 'react';
import { home } from '../../copy/home.ts';
import { zonedDateKey } from '../calendar/time.ts';
import { useCompany } from '../settings/api.ts';
import { useStorms } from '../storm/api.ts';
import { daysBetween, latestStorm, stormWhen } from './homeFacts.ts';
import styles from './StormCallout.module.css';

/** A storm older than this is no longer news on Home: it stays on the Storm page and in the numbers strip. */
const NEWS_DAYS = 7;

/**
 * The note floating over the map's top left when hail crossed the area lately: how big, where, how many customers
 * and homes were inside, what the plan stands at, and a button into the storm report. It can be dismissed for the visit.
 */
export function StormCallout() {
  const storms = useStorms();
  const company = useCompany();
  // The storm the person dismissed, so a newer one still shows
  const [dismissed, setDismissed] = useState<string | null>(null);

  const storm = latestStorm(storms.data?.storms);
  if (storm === undefined || dismissed === storm.id) return null;
  const todayKey = zonedDateKey(new Date(), company.data?.timezone ?? 'America/Chicago');
  if (daysBetween(storm.day, todayKey) > NEWS_DAYS) return null;

  const when = stormWhen(storm.day, todayKey);
  const plan = storm.planStatus === null ? home.stormNoPlan : (home.stormPlan[storm.planStatus] ?? home.stormNoPlan);

  return (
    <section className={styles.callout} aria-label={home.stormRegion}>
      <span className={styles.icon} aria-hidden="true">
        <Icon name="storm" size={22} />
      </span>
      <div className={styles.text}>
        <h2 className={styles.title}>{home.stormTitle(Number(storm.maxIn.toFixed(2)).toString(), storm.placeName, home.stormWhen(when.kind, when.label))}</h2>
        <p className={styles.body}>{home.stormBody(storm.customersHit, storm.homesHit, plan)}</p>
      </div>
      <div className={styles.actions}>
        <Button size="sm" variant="default" href={'/storm/' + encodeURIComponent(storm.id)}>
          {home.openStormReport}
        </Button>
        <IconButton label={home.stormDismiss} className={styles.dismiss} onClick={() => setDismissed(storm.id)} icon={<Icon name="x" size={16} />} />
      </div>
    </section>
  );
}
