import { IconButton, UiLink } from '@roofline/ui';
import { home } from '../../copy/home.ts';
import type { StormSummary } from '../storm/types.ts';
import styles from './StormToast.module.css';

/** The Storm Scout toast over the map's corner: the hail report is ready, with a button into the storm. */
export function StormToast({ storm, when, onDismiss }: { storm: StormSummary; when: string; onDismiss: () => void }) {
  return (
    <div className={styles.wrap}>
      <div role="status" className={styles.toast}>
        <div className={styles.head}>
          <span className={styles.app}>
            <span className={styles.mark} aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <path d="M2.5 7.5L6 4l3.5 3.5" />
              </svg>
            </span>
            {home.toastApp}
          </span>
          <span className={styles.now}>
            {home.toastNow}
            <IconButton
              label={home.toastDismiss}
              className={styles.dismiss}
              onClick={onDismiss}
              icon={
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" focusable="false">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              }
            />
          </span>
        </div>
        <div className={styles.title}>{home.toastTitle}</div>
        <div className={styles.body}>{home.toastBody(storm.homesHit, when)}</div>
        <div className={styles.cta}>
          <UiLink href={'/storm/' + encodeURIComponent(storm.id)} className={styles.review}>
            {home.toastReview}
          </UiLink>
        </div>
      </div>
    </div>
  );
}
