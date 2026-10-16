import { ProgressRing, UiLink } from '@roofline/ui';
import { setup } from '../../copy/setup.ts';
import { useSetup } from '../../features/setup/api.ts';
import styles from './MoreSheet.module.css';

/** Setup progress as a row of the More sheet: the ring and what it says. Nothing while it is unknown or once every step is done. */
export function MoreSetup() {
  const { data } = useSetup();
  if (!data) return null;
  const { done, total } = data.progress;
  if (done >= total) return null;
  const label = setup.ringLabel(done, total);
  return (
    <UiLink href="/settings/setup" className={styles.setup}>
      <ProgressRing done={done} total={total} label={label} size={24} />
      <span>{label}</span>
    </UiLink>
  );
}
