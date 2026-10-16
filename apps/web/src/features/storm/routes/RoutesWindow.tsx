import { storm } from '../../../copy/storm.ts';
import { doors } from '../../../copy/doors.ts';
import { AppPage } from '../../../shell/AppPage.tsx';
import { MyRoutes } from './MyRoutes.tsx';

/** The routes list under Storm: the rep's routes, one card each, under a trail back to Storm. */
export function RoutesWindow() {
  return (
    <AppPage
      app="storm"
      heading={doors.myRoutesLink}
      subtitle={doors.myRoutesHelp}
      crumbs={[{ label: storm.crumbStorm, href: '/storm' }, { label: doors.myRoutesLink }]}
    >
      <MyRoutes />
    </AppPage>
  );
}
