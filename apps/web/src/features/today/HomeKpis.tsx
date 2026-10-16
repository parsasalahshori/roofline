import { KpiTile, Skeleton } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { home } from '../../copy/home.ts';
import { liftSigned, signedMoney } from '../../copy/liftSigned.ts';
import { zonedDateKey } from '../calendar/time.ts';
import { useBoard } from '../jobs/api.ts';
import { useCompany } from '../settings/api.ts';
import { useStorms } from '../storm/api.ts';
import { useFrontDeskWeek } from './api.ts';
import { latestStorm, pipelineCounts, stormWhen } from './homeFacts.ts';
import styles from './HomeKpis.module.css';
import { useSignedSummary } from './lift/signedApi.ts';

/** The placeholder for a number on its way: the height of the number it will be. */
const waiting = <Skeleton width="6rem" height="28px" />;


/** The signed total of this month, with the twelve weeks behind it as bars (left out where `bars` is false). */
export function SignedTile({ bars = true }: { bars?: boolean }) {
  const signed = useSignedSummary();
  const data = signed.data;
  const percent = data?.goalCents ? Math.round((data.monthTotalCents / data.goalCents) * 100) : null;
  // The weekly bars only when some week has something in it
  const spark = bars && data?.weekly.some((week) => week.totalCents > 0) ? data.weekly.map((week) => week.totalCents) : undefined;

  return (
    <KpiTile
      label={home.signed}
      value={data ? signedMoney(data.monthTotalCents) : signed.isError ? '—' : waiting}
      meta={
        data
          ? data.monthTotalCents === 0
            ? home.signedNothing
            : percent !== null && data.goalCents
              ? home.signedGoal(percent, signedMoney(data.goalCents))
              : home.signedMeta
          : signed.isError
            ? home.kpiLoadFailed
            : undefined
      }
      spark={spark}
      sparkLabel={liftSigned.chartLabel}
    />
  );
}

/** The proposals out for a signature, in dollars, with how many jobs are open and how many are at Proposal. */
export function PipelineTile() {
  const signed = useSignedSummary();
  const board = useBoard({});
  const counts = pipelineCounts(board.data);
  return (
    <KpiTile
      label={home.pipeline}
      value={signed.data ? signedMoney(signed.data.openPipelineCents) : signed.isError ? '—' : waiting}
      meta={counts ? home.pipelineMeta(counts.openJobs, counts.atProposal) : board.isError ? home.kpiLoadFailed : undefined}
    />
  );
}

/**
 * The strip of four numbers over the map: what was signed this month (with the twelve weeks behind it), the open
 * pipeline, the latest hail and the Front Desk's week. Every one is read from the company's own data; a number that
 * cannot be read says so beside itself and leaves the others alone. A rep has no Front Desk tile.
 */
export function HomeKpis() {
  const me = useMe();
  const company = useCompany();
  const storms = useStorms();
  const canSeeDesk = me.data?.role === 'owner' || me.data?.role === 'office';
  const desk = useFrontDeskWeek(canSeeDesk);

  const zone = company.data?.timezone ?? 'America/Chicago';
  const storm = latestStorm(storms.data?.storms);

  return (
    <section className={styles.strip} aria-label={home.kpisLabel}>
      <SignedTile />
      <PipelineTile />
      {storm ? (
        <KpiTile
          label={home.hail(stormWhen(storm.day, zonedDateKey(new Date(), zone)).label)}
          value={storm.maxIn.toFixed(2)}
          unit={home.hailUnit}
          meta={
            <>
              <b className={styles.count}>{storm.customersHit}</b> {home.hailInside(storm.customersHit)}
            </>
          }
        />
      ) : (
        <KpiTile
          label={home.hail(null)}
          value={storms.isPending ? waiting : home.hailNone}
          meta={storms.isError ? home.kpiLoadFailed : storms.isPending ? undefined : home.hailNoneMeta}
        />
      )}
      {canSeeDesk ? (
        <KpiTile
          label={home.desk}
          value={desk.data ? desk.data.answered : desk.isError ? '—' : waiting}
          unit={desk.data ? home.deskUnit : undefined}
          meta={desk.data ? home.deskMeta(desk.data.booked, desk.data.transferred) : desk.isError ? home.kpiLoadFailed : undefined}
        />
      ) : null}
    </section>
  );
}
