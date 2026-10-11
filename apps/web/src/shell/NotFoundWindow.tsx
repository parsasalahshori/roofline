import { Button, EmptyState } from '@roofline/ui';
import { shell } from '../copy/shell.ts';
import { AppWindow } from './AppWindow.tsx';

/** The window for an address that leads nowhere. Its one action goes back to the map. */
export function NotFoundWindow() {
  return (
    <AppWindow app="notFound">
      <EmptyState title={shell.notFoundTitle} action={<Button variant="primary" href="/">{shell.backToMap}</Button>} />
    </AppWindow>
  );
}
