import type { HTMLAttributes } from 'react';
import { cx } from '../../cx.ts';
import styles from './Card.module.css';

export type CardProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'li';
  /** Inner padding. Turn it off for a card that holds a list or a table edge to edge. */
  padded?: boolean;
};

export function Card({ as: Tag = 'div', padded = true, className, ...rest }: CardProps) {
  return <Tag {...rest} className={cx(styles.card, className)} data-padded={padded} />;
}
