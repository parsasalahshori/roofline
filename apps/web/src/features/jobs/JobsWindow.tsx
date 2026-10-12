import { useSearchParams } from 'react-router';
import { Board } from './Board.tsx';
import { BoardFilters } from './BoardFilters.tsx';
import { JobsList } from './JobsList.tsx';
import { JobsTabs } from './JobsTabs.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';

/** The Jobs window: the tab row, the filters, then the pipeline board or the list (always the list on a phone). */
export function JobsWindow() {
  const [params] = useSearchParams();
  const phone = useIsPhone();
  const listView = phone || params.get('view') === 'list';

  return (
    <>
      <JobsTabs />
      <BoardFilters />
      {listView ? <JobsList /> : <Board />}
    </>
  );
}
