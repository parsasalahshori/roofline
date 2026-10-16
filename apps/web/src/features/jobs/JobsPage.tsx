import { useSearchParams } from 'react-router';
import { AppPage } from '../../shell/AppPage.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { JobsWindow } from './JobsWindow.tsx';

/** The Jobs page. The board takes the screen's height and its lanes scroll; the list (always the list on a phone) flows down the page. */
export function JobsPage() {
  const [params] = useSearchParams();
  const phone = useIsPhone();
  const listView = phone || params.get('view') === 'list';
  return (
    <AppPage app="jobs" layout={listView ? 'flow' : 'fill'}>
      <JobsWindow />
    </AppPage>
  );
}
