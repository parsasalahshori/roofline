import { useIsPhone } from '../../shell/useIsPhone.ts';
import { Board } from './Board.tsx';
import { BoardFilters } from './BoardFilters.tsx';
import { useJobsView } from './filter.ts';
import { JobsList } from './JobsList.tsx';

/** The body of the Jobs page: the filter bar, then the pipeline board or the list (always the list on a phone). */
export function JobsWindow({ narrowed }: { narrowed: boolean }) {
  const phone = useIsPhone();
  const view = useJobsView();
  const listView = phone || view === 'list';

  return (
    <>
      <BoardFilters />
      {listView ? <JobsList narrowed={narrowed} /> : <Board narrowed={narrowed} />}
    </>
  );
}
