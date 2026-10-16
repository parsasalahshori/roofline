import { Page } from '@roofline/ui';
import { shell } from '../copy/shell.ts';
import { Home } from '../features/today/Home.tsx';
import { MapPanel } from './MapPanel.tsx';
import { useIsPhone } from './useIsPhone.ts';

/** The page at "/": Home on a desktop; on a phone the map, full screen under a short head (Home's cards are Today there). */
export function HomeRoute() {
  const phone = useIsPhone();
  if (!phone) return <Home />;
  return (
    <Page title={shell.tabMap} crumbsLabel={shell.crumbsLabel} layout="fill">
      <MapPanel />
    </Page>
  );
}
