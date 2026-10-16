import { Button, Icon } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { formatPhone } from '../../lib/phone.ts';
import { useSimulate } from '../demo/api.ts';
import { useCompany } from '../settings/api.ts';
import styles from './PageHead.module.css';

const copy = frontDeskInbox;

/** The line under the page title: a live dot and the number the assistant answers. */
export function FrontDeskStatus() {
  const phone = useCompany().data?.phone;
  const number = phone ? formatPhone(phone) : null;
  return (
    <span className={styles.status} data-testid="fd-status">
      <span className={styles.dot} aria-hidden="true" />
      {number === null ? copy.answeringNoNumber : copy.answering(number)}
    </span>
  );
}

/** The demo's button: makes a call come in, so the screen has something to show. Only drawn in demo mode. */
export function SimulateCallButton() {
  const simulate = useSimulate();
  return (
    <Button variant="default" data-testid="fd-simulate-call" busy={simulate.isPending} onClick={() => simulate.mutate('call')}>
      <Icon name="phone" size={16} />
      {copy.simulateCall}
    </Button>
  );
}
