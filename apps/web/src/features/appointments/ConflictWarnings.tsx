import { Banner, Button } from '@roofline/ui';
import { appointments } from '../../copy/appointments.ts';
import type { ConflictWarningsProps } from './types.ts';
import styles from './ConflictWarnings.module.css';

/**
 * The warnings the server gave after a save, each with its own line and a glyph so they do not rely on colour. They never
 * refuse the save: the person changes the time (the quiet way out) or keeps it.
 */
export function ConflictWarnings({ warnings, onKeep, onChange }: ConflictWarningsProps) {
  if (warnings.length === 0) return null;
  return (
    <Banner
      tone="warning"
      action={
        <div className={styles.actions}>
          <Button variant="default" onClick={onChange}>
            {appointments.changeTime}
          </Button>
          <Button variant="ghost" onClick={onKeep}>
            {appointments.keepIt}
          </Button>
        </div>
      }
    >
      {warnings.map((warning, index) => (
        <p key={`${index}-${warning}`} className={styles.warning}>
          {warning}
        </p>
      ))}
    </Banner>
  );
}
