import { Button, Icon, Skeleton } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { jobs } from '../../copy/jobs.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { useBoard } from './api.ts';
import { isNarrowed, useBoardFilter, useJobsView } from './filter.ts';
import { JobsTabs } from './JobsTabs.tsx';
import { JobsWindow } from './JobsWindow.tsx';
import { useJobsSubtitle } from './useJobsSubtitle.tsx';

/**
 * The Jobs page: its head (counts under the title, Export and New job), the Pipeline / Customers / Archived tabs and the
 * board or list. The board takes the screen's height and its lanes scroll; the list (always the list on a phone) flows
 * down the page.
 */
export function JobsPage() {
  const phone = useIsPhone();
  const view = useJobsView();
  const listView = phone || view === 'list';
  const me = useMe();
  const filter = useBoardFilter();
  const board = useBoard(filter);
  const subtitle = useJobsSubtitle(board.data, filter);
  const canExport = me.data?.role === 'owner' || me.data?.role === 'office';

  return (
    <AppPage
      app="jobs"
      layout={listView ? 'flow' : 'fill'}
      subtitle={subtitle ?? (board.isError ? '' : <Skeleton width="260px" height="1rem" />)}
      tabs={<JobsTabs />}
      actions={
        <>
          {canExport ? (
            <Button href="/api/export/jobs.csv" variant="default" {...{ download: true }}>
              <Icon name="download" size={16} />
              {jobs.export}
            </Button>
          ) : null}
          <Button href="/jobs/new" variant="primary">
            <Icon name="plus" size={16} />
            {jobs.newJob}
          </Button>
        </>
      }
    >
      <JobsWindow narrowed={isNarrowed(filter)} />
    </AppPage>
  );
}
