import { Button, ProgressRing } from '@roofline/ui';
import { setup } from '../../copy/setup.ts';
import { useSetup } from './api.ts';
import styles from './SetupRing.module.css';

/*
 * The setup progress in the rail's foot, above the person: the ring and its count in words ("2 of 5 setup steps done"),
 * a link to the Setup tab. A ring alone read as a spinner that never finishes, so the words are always shown (the icon
 * rail below 1100px keeps them for screen readers). Hidden while the progress is unknown (loading or failed) and once
 * every step is done.
 */
export function SetupRing() {
  const { data } = useSetup();
  if (!data) return null;

  const { done, total } = data.progress;
  if (done >= total) return null;

  const label = setup.ringLabel(done, total);
  return (
    <Button variant="ghost" href="/settings/setup" className={styles.link}>
      {/* The words beside it carry the name; the ring is the picture of them */}
      <span aria-hidden="true" className={styles.ring}>
        <ProgressRing done={done} total={total} label={label} size={24} />
      </span>
      <span className={styles.text}>{label}</span>
    </Button>
  );
}
