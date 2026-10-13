import type { ReactNode } from 'react';
import { Button, Skeleton } from '@roofline/ui';
import { frontDeskInbox } from '../../../copy/front-desk-inbox.ts';
import { formatPhone } from '../../../lib/phone.ts';
import { useDemoMode, useSimulate } from '../../demo/api.ts';
import { useCompany } from '../../settings/api.ts';
import { useDayStats } from '../inbox-api.ts';
import { secondsText } from './format.ts';
import styles from './KpiTiles.module.css';

const copy = frontDeskInbox.lift;

function Tile({ label, value, hint, highlight }: { label: string; value: ReactNode; hint: string; highlight?: boolean }) {
  return (
    <div className={styles.tile} data-highlight={highlight ? 'true' : undefined} data-testid="kpi-tile">
      <dl className={styles.stat}>
        <dt className={styles.label}>{label}</dt>
        <dd className={styles.value}>{value}</dd>
        <dd className={styles.hint}>{hint}</dd>
      </dl>
    </div>
  );
}

/** The "Answering (number)" tile. In demo mode it also holds the presenter's "Simulate a call" button; elsewhere it is only the status. */
function AnsweringTile() {
  const isDemo = useDemoMode();
  const simulate = useSimulate();
  const phone = useCompany().data?.phone;
  const number = phone ? formatPhone(phone) : null;
  return (
    <div className={styles.tile} data-status="true" data-testid="kpi-answering">
      <p className={styles.answering}>
        <span className={styles.dot} aria-hidden="true" />
        {number === null ? copy.answeringNoNumber : copy.answering(number)}
      </p>
      {isDemo ? (
        <Button
          className={styles.simulate}
          data-testid="simulate-call"
          busy={simulate.isPending}
          onClick={() => simulate.mutate('call')}
        >
          {copy.simulateCall}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The row of today's numbers, all from GET /api/front-desk/stats?day=today. It fetches its own numbers and never blocks the list.
 * The caller shows it to the owner and the office only (the server refuses a rep).
 */
export function KpiTiles() {
  const { data, isPending, isError } = useDayStats();

  let tiles: ReactNode;
  if (isError) {
    tiles = <p className={styles.note}>{copy.kpisError}</p>;
  } else if (isPending || data === undefined) {
    tiles = (
      <>
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className={styles.tile} aria-busy="true">
            <Skeleton width="60%" />
            <Skeleton width="40%" height="1.5rem" />
          </div>
        ))}
      </>
    );
  } else {
    tiles = (
      <>
        <Tile label={copy.callsToday} value={data.callsToday} hint={copy.callsTodayHint} />
        <Tile
          label={copy.answered}
          value={data.answeredPct === null ? copy.answeredNone : `${data.answeredPct}%`}
          hint={copy.answeredHint(data.booked, data.escalated)}
        />
        <Tile
          label={copy.answerTime}
          value={data.avgAnswerMs === null ? copy.answerTimeNone : copy.seconds(secondsText(data.avgAnswerMs))}
          hint={copy.answerTimeHint}
          highlight
        />
        <Tile label={copy.inspections} value={data.inspectionsBooked} hint={copy.inspectionsHint} />
        <Tile label={copy.afterHours} value={data.afterHours} hint={copy.afterHoursHint} />
      </>
    );
  }

  return (
    <section className={styles.root} aria-label={copy.kpisLabel}>
      {tiles}
      <AnsweringTile />
    </section>
  );
}
