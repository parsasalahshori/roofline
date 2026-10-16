import { Button, EmptyState } from '@roofline/ui';
import { shell } from '../copy/shell.ts';
import { AppPage } from './AppPage.tsx';

/** The page for an address that leads nowhere. Its one action goes home. */
export function NotFoundWindow() {
  return (
    <AppPage app="notFound">
      <EmptyState title={shell.notFoundTitle} action={<Button variant="primary" href="/">{shell.backHome}</Button>} />
    </AppPage>
  );
}
