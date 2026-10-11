import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../cx.ts';
import { Pressable } from '../../pressable.tsx';
import styles from './IconButton.module.css';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** What the button does. Becomes its accessible name; the icon itself is hidden from assistive tech. */
  label: string;
  icon: ReactNode;
  /** Draws a link instead of a button. */
  href?: string;
};

export function IconButton({ label, icon, className, ...rest }: IconButtonProps) {
  return (
    <Pressable {...rest} aria-label={label} className={cx(styles.iconButton, className)}>
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
    </Pressable>
  );
}
