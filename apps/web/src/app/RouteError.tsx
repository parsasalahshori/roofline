import { Button } from '@roofline/ui';
import { errors } from '../copy/errors.ts';
import styles from './RouteError.module.css';

/**
 * What a route shows when it fails to render, instead of the router's own error page: it says the
 * work is safe and offers a reload. `window` fills the shell's window area (a window that crashed),
 * so the map, dock and top bar stay; `page` is the last resort for anything outside the shell.
 */
export function RouteError({ variant = 'page' }: { variant?: 'page' | 'window' }) {
  return (
    <div role="alert" className={styles.page} data-variant={variant}>
      <h1 className={styles.title}>{errors.pageTitle}</h1>
      <p className={styles.body}>{errors.pageBody}</p>
      <div>
        <Button onClick={() => window.location.reload()}>{errors.reload}</Button>
      </div>
    </div>
  );
}
