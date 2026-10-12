import { BOARD_STAGES, type BoardColumn, type JobCard, type JobStage } from '@roofline/shared';
import { Button, EmptyState, Pill, Skeleton, UiLink } from '@roofline/ui';
import { jobs } from '../../copy/jobs.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { useBoardFilter } from './BoardFilters.tsx';
import { formatDollars } from './JobCardView.tsx';
import { type BoardFilterParams, useBoard, useColumnPages } from './api.ts';
import { MoveJobMenu } from './MoveJobMenu.tsx';
import styles from './JobsList.module.css';

const STAGE_ORDER = BOARD_STAGES as readonly JobStage[];

/** The most recently updated job first. */
const byUpdated = (a: JobCard, b: JobCard): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

const formatUpdated = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));

const stageChip = (job: JobCard) => <Pill tone="neutral">{jobs.stage[job.stage]}</Pill>;
const valueText = (job: JobCard) => (job.valueCents === null ? '' : formatDollars(job.valueCents));
const repText = (job: JobCard) => (job.assigned === null ? jobs.unassigned : job.assigned.name);

type ListStageProps = { column: BoardColumn; filter: BoardFilterParams; phone: boolean };

/**
 * One stage of the list: its loaded jobs, most recently updated first, and a 'Show N more' button
 * while the stage has jobs that are not loaded yet. A desktop stage is a table body; on a phone its rows are list items.
 */
function ListStage({ column, filter, phone }: ListStageProps) {
  const { visible, remaining, busy, more } = useColumnPages(column, filter);
  if (visible.length === 0 && remaining <= 0) return null;

  const rows = [...visible].sort(byUpdated);
  const showMore = remaining > 0 ? (
    <Button variant="ghost" busy={busy} onClick={more}>
      {jobs.showMore(remaining)}
    </Button>
  ) : null;

  if (phone) {
    return (
      <>
        {rows.map((job) => (
          <li key={job.id} className={styles.row} data-stage={job.stage}>
            <UiLink href={`/jobs/${job.id}`} className={styles.jobLink}>
              <span className={styles.name}>{job.customerName}</span>
              <span className={styles.address}>{job.addressLine}</span>
            </UiLink>
            <div className={styles.meta}>
              {stageChip(job)}
              <span>{valueText(job)}</span>
              <span>{repText(job)}</span>
              <span>{formatUpdated(job.updatedAt)}</span>
            </div>
            <MoveJobMenu job={job} compact />
          </li>
        ))}
        {showMore === null ? null : <li>{showMore}</li>}
      </>
    );
  }

  return (
    <tbody data-stage={column.stage}>
      {rows.map((job) => (
        <tr key={job.id} data-stage={job.stage}>
          <td>
            <UiLink href={`/jobs/${job.id}`} className={styles.jobLink}>
              <span className={styles.name}>{job.customerName}</span>
              <span className={styles.address}>{job.addressLine}</span>
            </UiLink>
          </td>
          <td>{stageChip(job)}</td>
          <td className={styles.num}>{valueText(job)}</td>
          <td>{repText(job)}</td>
          <td>{formatUpdated(job.updatedAt)}</td>
          <td>
            <MoveJobMenu job={job} compact />
          </td>
        </tr>
      ))}
      {showMore === null ? null : (
        <tr>
          <td colSpan={6}>{showMore}</td>
        </tr>
      )}
    </tbody>
  );
}

/** The jobs as a list: a table on a desktop, stacked rows on a phone. Each row has the Move-to menu. */
export function JobsList() {
  const filter = useBoardFilter();
  const board = useBoard(filter);
  const phone = useIsPhone();

  if (board.isError) {
    return (
      <EmptyState
        title={jobs.loadFailed}
        action={
          <Button variant="ghost" onClick={() => void board.refetch()}>
            {jobs.retry}
          </Button>
        }
      />
    );
  }

  if (board.data === undefined) {
    return (
      <div role="status" aria-label={jobs.loading} className={styles.loading}>
        <Skeleton lines={4} height="48px" />
      </div>
    );
  }

  const columns = [...board.data.columns].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
  if (columns.every((column) => column.count === 0)) return <EmptyState title={jobs.listEmpty} />;

  if (phone) {
    return (
      <ul className={styles.stack} aria-label={jobs.listLabel}>
        {columns.map((column) => (
          <ListStage key={column.stage} column={column} filter={filter} phone />
        ))}
      </ul>
    );
  }

  return (
    <table className={styles.table} aria-label={jobs.listLabel}>
      <thead>
        <tr>
          <th scope="col">{jobs.listColumns.job}</th>
          <th scope="col">{jobs.listColumns.stage}</th>
          <th scope="col">{jobs.listColumns.value}</th>
          <th scope="col">{jobs.listColumns.rep}</th>
          <th scope="col">{jobs.listColumns.updated}</th>
          <th scope="col">{jobs.listColumns.move}</th>
        </tr>
      </thead>
      {columns.map((column) => (
        <ListStage key={column.stage} column={column} filter={filter} phone={false} />
      ))}
    </table>
  );
}
