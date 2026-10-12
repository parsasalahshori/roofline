import type { ReactNode } from 'react';
import styles from './Banner.module.css';

export type BannerProps = {
  tone: 'info' | 'warning' | 'danger';
  children: ReactNode;
  action?: ReactNode;
};

/**
 * A full-width message strip. A danger banner is an alert so it is announced at once; the other
 * tones are status updates. The action sits beside the text, and wraps under it on a phone.
 */
export function Banner({ tone, children, action }: BannerProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-tone={tone}
      className={styles.banner}
    >
      <div className={styles.text}>{children}</div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
