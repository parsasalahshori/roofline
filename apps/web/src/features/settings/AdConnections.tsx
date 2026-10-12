import { Card } from '@roofline/ui';
import { ads } from '../../copy/ads.ts';
import { connections } from '../../copy/connections.ts';
import styles from './AdConnections.module.css';

/** The slot for ad account connections under Connections. */
export function AdConnections() {
  return (
    <Card as="section" className={styles.slot}>
      <p className={styles.note}>{ads.connectionsComingSoon}</p>
      <ul className={styles.list}>
        <li>{connections.googleAds}</li>
        <li>{connections.meta}</li>
      </ul>
    </Card>
  );
}
