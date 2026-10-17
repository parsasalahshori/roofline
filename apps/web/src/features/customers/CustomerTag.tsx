import { Tag } from '@roofline/ui';
import type { ReactNode } from 'react';
import styles from './CustomerTag.module.css';

/**
 * One of a customer's own tags: a word the owner chose, up to 40 characters with no break in it. The kit's tag is a single
 * line that never shrinks, so a long one ran out of the Contact panel and out of a table cell; this one wraps in its column.
 */
export function CustomerTag({ children }: { children: ReactNode }) {
  return <Tag className={styles.tag}>{children}</Tag>;
}
