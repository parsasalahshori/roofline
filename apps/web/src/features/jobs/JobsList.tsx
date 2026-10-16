import { BOARD_STAGES, type BoardColumn, type JobCard, type JobStage } from '@roofline/shared';
import { Avatar, Button, Icon, Table, Td, Th, Tr, UiLink } from '@roofline/ui';
import { useSearchParams } from 'react-router';
import { jobs } from '../../copy/jobs.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { useBoard, useColumnPages, type BoardFilterParams } from './api.ts';
import { useBoardFilter } from './filter.ts';
import { formatDollars } from './format.ts';
import { Aging } from './JobCardView.tsx';
import { MoveJobMenu } from './MoveJobMenu.tsx';
import { StageTag } from './StageTag.tsx';
import { EmptyPanel, LoadError } from './states.tsx';
import styles from './JobsList.module.css';

const STAGE_ORDER = BOARD_STAGES as readonly JobStage[];

/** The most recently updated job first. */
const byUpdated = (a: JobCard, b: JobCard): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

const updatedFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const formatUpdated = (iso: string): string => updatedFormat.format(new Date(iso));

/** The rep as an avatar and a name, or "Unassigned" in the quiet colour. */
function Rep({ job }: { job: JobCard }) {
  if (job.assigned === null) return <span className={styles.unassigned}>{jobs.unassigned}</span>;
  return (
    <span className={styles.rep}>
      <Avatar name={job.assigned.name} size={24} />
      <span>{job.assigned.name}</span>
    </span>
  );
}

type ListStageProps = { column: BoardColumn; filter: BoardFilterParams; phone: boolean };

/**
 * One stage of the list: its loaded jobs, most recently updated first, and a 'Show N more' button
 * while the stage has jobs that are not loaded yet. A desktop stage is a table body; on a phone its rows are cards.
 */
function ListStage({ column, filter, phone }: ListStageProps) {
  const { visible, remaining, busy, more } = useColumnPages(column, filter);
  if (visible.length === 0 && remaining <= 0) return null;

  const rows = [...visible].sort(byUpdated);
  const showMore = remaining > 0 ? (
    <Button variant="ghost" size="sm" busy={busy} onClick={more}>
      {jobs.showMore(remaining)}
    </Button>
  ) : null;

  if (phone) {
    return (
      <>
        {rows.map((job) => (
          <li key={job.id} className={styles.card} data-stage={job.stage}>
            <UiLink href={`/jobs/${job.id}`} className={styles.cardLink}>
              <span className={styles.cardTop}>
                <span className={styles.name}>{job.customerName}</span>
                <StageTag stage={job.stage} />
              </span>
              <span className={styles.address}>{job.addressLine}</span>
              <span className={styles.cardFoot}>
                {job.valueCents !== null ? <span className={styles.value}>{formatDollars(job.valueCents)}</span> : null}
                <Rep job={job} />
                <Aging days={job.daysInStage} stuck={job.stuck} />
              </span>
            </UiLink>
            <div className={styles.cardMove}>
              <MoveJobMenu job={job} compact />
            </div>
          </li>
        ))}
        {showMore === null ? null : <li>{showMore}</li>}
      </>
    );
  }

  return (
    <tbody data-stage={column.stage} className={styles.group}>
      {rows.map((job) => (
        <Tr key={job.id} data-stage={job.stage}>
          <Td>
            <UiLink href={`/jobs/${job.id}`} className={styles.jobLink}>
              <span className={styles.name}>{job.customerName}</span>
              <span className={styles.address}>{job.addressLine}</span>
            </UiLink>
          </Td>
          <Td>
            <StageTag stage={job.stage} />
          </Td>
          <Td numeric>{job.valueCents === null ? '' : formatDollars(job.valueCents)}</Td>
          <Td>
            <Rep job={job} />
          </Td>
          <Td numeric>
            <Aging days={job.daysInStage} stuck={job.stuck} />
          </Td>
          <Td className={styles.updated}>{formatUpdated(job.updatedAt)}</Td>
          <Td className={styles.move}>
            <MoveJobMenu job={job} compact />
          </Td>
        </Tr>
      ))}
      {showMore === null ? null : (
        <tr>
          <td colSpan={7} className={styles.moreCell}>
            {showMore}
          </td>
        </tr>
      )}
    </tbody>
  );
}

/** The ghost of the table while the jobs load: the head and a few rows, in the sunken colour. */
function ListSkeleton() {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <span key={row} className={styles.skeletonRow}>
          <i className={styles.skeletonDot} />
          <b className={styles.skeletonBar} />
          <b className={styles.skeletonBarShort} />
        </span>
      ))}
    </div>
  );
}

export type JobsListProps = {
  /** An assignee, a source or a search is narrowing the list. */
  narrowed: boolean;
};

/** The jobs as a list: a table on a desktop, stacked cards on a phone. Each row has the Move-to menu. */
export function JobsList({ narrowed }: JobsListProps) {
  const filter = useBoardFilter();
  const board = useBoard(filter);
  const phone = useIsPhone();
  const [, setParams] = useSearchParams();

  if (board.isError) {
    return (
      <LoadError
        tag={jobs.errorTag}
        title={jobs.loadFailed}
        retry={jobs.retry}
        busy={board.isFetching}
        onRetry={() => void board.refetch()}
      />
    );
  }

  if (board.data === undefined) {
    return (
      <div role="status" aria-label={jobs.loading} className={styles.loading}>
        <ListSkeleton />
      </div>
    );
  }

  const columns = [...board.data.columns].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
  if (columns.every((column) => column.count === 0)) {
    if (narrowed) {
      return (
        <EmptyPanel
          title={jobs.emptyFiltered}
          body={jobs.emptyFilteredBody}
          action={
            <Button
              variant="default"
              onClick={() =>
                setParams(
                  (previous) => {
                    const next = new URLSearchParams(previous);
                    for (const key of ['assigned', 'source', 'q']) next.delete(key);
                    return next;
                  },
                  { replace: true },
                )
              }
            >
              {jobs.clearFilters}
            </Button>
          }
        />
      );
    }
    if (filter.archived === true) return <EmptyPanel title={jobs.emptyArchived} body={jobs.emptyArchivedBody} />;
    return (
      <EmptyPanel
        title={jobs.emptyBoard}
        body={jobs.emptyBoardBody}
        action={
          <Button href="/jobs/new" variant="primary">
            <Icon name="plus" size={16} />
            {jobs.newJob}
          </Button>
        }
      />
    );
  }

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
    <div className={styles.panel}>
      <Table aria-label={jobs.listLabel}>
        <thead>
          <tr>
            <Th>{jobs.listColumns.job}</Th>
            <Th>{jobs.listColumns.stage}</Th>
            <Th numeric>{jobs.listColumns.value}</Th>
            <Th>{jobs.listColumns.rep}</Th>
            <Th numeric>{jobs.listColumns.age}</Th>
            <Th>{jobs.listColumns.updated}</Th>
            <Th>
              <span className="visually-hidden">{jobs.listColumns.move}</span>
            </Th>
          </tr>
        </thead>
        {columns.map((column) => (
          <ListStage key={column.stage} column={column} filter={filter} phone={false} />
        ))}
      </Table>
    </div>
  );
}
