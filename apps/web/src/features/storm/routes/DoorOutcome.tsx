import { Button } from '@roofline/ui';
import { useState } from 'react';
import { doors } from '../../../copy/doors.ts';
import { ApiError } from '../../../api/client.ts';
import { useRecordOutcome } from './api.ts';
import styles from './DoorOutcome.module.css';
import type { DoorLead, DoorOutcomeKey, DoorStop } from './types.ts';
import { WantsCheckSheet } from './WantsCheckSheet.tsx';

/** The outcomes in the order they are shown. */
const DOOR_OUTCOME: readonly DoorOutcomeKey[] = ['not_home', 'wants_check', 'not_interested', 'has_roofer', 'do_not_knock'];

/** The five buttons for one door. A new door is a new key, so no state carries over from the last one. */
export function DoorOutcome({ routeId, stop }: { routeId: string; stop: DoorStop }) {
  return <DoorOutcomeForStop key={stop.id} routeId={routeId} stop={stop} />;
}

function DoorOutcomeForStop({ routeId, stop }: { routeId: string; stop: DoorStop }) {
  const record = useRecordOutcome();
  const [sheetOpen, setSheetOpen] = useState(false);

  const pendingOutcome = record.isPending ? record.variables?.outcome : undefined;
  const failure = record.error;
  // A network failure (status 0) gets the plain "Not saved" line; any other refusal shows its own message
  const failureMessage = failure === null ? null : failure instanceof ApiError && failure.status === 0 ? doors.notSaved : failure.message;

  const send = (outcome: Exclude<DoorOutcomeKey, 'wants_check'>) => {
    record.mutate({ routeId, stopId: stop.id, outcome });
  };

  const openSheet = () => {
    record.reset();
    setSheetOpen(true);
  };

  const submitLead = (lead: DoorLead) => {
    record.mutate(
      { routeId, stopId: stop.id, outcome: 'wants_check', lead },
      { onSuccess: () => setSheetOpen(false) },
    );
  };

  return (
    <section className={styles.panel} aria-labelledby={`${stop.id}-outcome-heading`}>
      <h3 id={`${stop.id}-outcome-heading`} className={styles.heading}>
        {doors.outcomeHeading}
      </h3>
      <div className={styles.buttons}>
        {DOOR_OUTCOME.map((outcome) => (
          <Button
            key={outcome}
            size="lg"
            className={styles.outcome}
            disabled={record.isPending}
            busy={pendingOutcome === outcome}
            onClick={outcome === 'wants_check' ? openSheet : () => send(outcome)}
          >
            {doors.outcomes[outcome]}
          </Button>
        ))}
      </div>
      {failureMessage !== null && !sheetOpen ? (
        <p role="alert" className={styles.alert}>
          {failureMessage}
        </p>
      ) : null}
      <WantsCheckSheet
        open={sheetOpen}
        busy={record.isPending}
        failed={sheetOpen && failure !== null}
        onClose={() => setSheetOpen(false)}
        onSubmit={submitLead}
      />
    </section>
  );
}
