import { Banner, Button } from '@roofline/ui';
import { appointments } from '../../copy/appointments.ts';
import type { ConflictWarningsProps } from './types.ts';

/** The warnings the server gave after a save. They never refuse the save: the person keeps the time or changes it. */
export function ConflictWarnings({ warnings, onKeep, onChange }: ConflictWarningsProps) {
  if (warnings.length === 0) return null;
  return (
    <Banner
      tone="warning"
      action={
        <>
          <Button variant="ghost" onClick={onKeep}>
            {appointments.keepIt}
          </Button>
          <Button variant="ghost" onClick={onChange}>
            {appointments.changeTime}
          </Button>
        </>
      }
    >
      {warnings.map((warning, index) => (
        <p key={`${index}-${warning}`}>{warning}</p>
      ))}
    </Banner>
  );
}
