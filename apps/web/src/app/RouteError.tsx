import { Button } from '@roofline/ui';
import { errors } from '../copy/errors.ts';
import styles from './RouteError.module.css';

/**
 * What a route shows when it fails to render: the router's own error page is replaced by this one,
 * which says the work is safe and offers a reload. The app is not blanked.
 */
export function RouteError() {
  return (
    <div role="alert" className={styles.page}>
      <h1 className={styles.title}>{errors.pageTitle}</h1>
      <p className={styles.body}>{errors.pageBody}</p>
      <div>
        <Button onClick={() => window.location.reload()}>{errors.reload}</Button>
      </div>
    </div>
  );
}
