import { Button } from '@roofline/ui';
import { useSearchParams } from 'react-router';
import { jobs } from '../../copy/jobs.ts';
import styles from './JobsTabs.module.css';
import { Board } from './Board.tsx';
import { BoardFilters } from './BoardFilters.tsx';
import { JobsList } from './JobsList.tsx';
import { JobsTabs } from './JobsTabs.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';

/** The Jobs window: the tab row, the filters, then the pipeline board or the list (always the list on a phone). */
export function JobsWindow() {
  const [params, setParams] = useSearchParams();
  const phone = useIsPhone();
  const listView = phone || params.get('view') === 'list';

  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <JobsTabs />
        {!phone ? (
          <div className={styles.views} role="group" aria-label={jobs.viewLabel}>
            {(['board', 'list'] as const).map((view) => (
              <Button
                key={view}
                variant="ghost"
                aria-pressed={listView === (view === 'list')}
                onClick={() => setParams((previous) => {
                  const next = new URLSearchParams(previous);
                  if (view === 'list') next.set('view', 'list');
                  else next.delete('view');
                  return next;
                }, { replace: true })}
              >
                {view === 'board' ? jobs.boardView : jobs.listView}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <BoardFilters />
      {listView ? <JobsList /> : <Board />}
    </div>
  );
}
