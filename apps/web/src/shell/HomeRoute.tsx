import { Page } from '@roofline/ui';
import { shell } from '../copy/shell.ts';
import { Home } from '../features/today/Home.tsx';
import { MapPanel } from './MapPanel.tsx';
import { useIsPhone } from './useIsPhone.ts';

/** The page at "/": Home on a desktop; on a phone the map, full screen (Home's cards are My day there). */
export function HomeRoute() {
  const phone = useIsPhone();
  if (!phone) return <Home />;
  return (
    <Page title={shell.tabMap} titleHidden crumbsLabel={shell.crumbsLabel} layout="fill" className={undefined}>
      <MapPanel />
    </Page>
  );
}
