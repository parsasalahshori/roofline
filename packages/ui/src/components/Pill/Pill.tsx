import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Pressable } from '../../pressable.tsx';
import styles from './Pill.module.css';

export type PillTone = 'accent' | 'neutral';

export type PillProps = {
  children: ReactNode;
  /** A link when given, a button otherwise. */
  href?: string;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
  tone?: PillTone;
};

export function Pill({ children, href, onClick, tone = 'accent' }: PillProps) {
  return (
    <Pressable href={href} onClick={onClick} className={styles.pill} data-tone={tone}>
      <span className={styles.label}>{children}</span>
    </Pressable>
  );
}
