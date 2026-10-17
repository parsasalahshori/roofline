import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../../cx.ts';
import { Pressable } from '../../pressable.tsx';
import styles from './Chip.module.css';

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'> & {
  children: ReactNode;
  /** A filter chip: on (ink) or off. Left out, the chip is a plain button or, with an href, a link. */
  pressed?: boolean;
  /** A number after the words, in mono ("Open 12"). */
  count?: number | string;
  /** A glyph before the words. */
  icon?: ReactNode;
  href?: string;
  busy?: boolean;
  ref?: Ref<HTMLButtonElement | HTMLAnchorElement>;
};

/** A 28px pill for filtering a list. On means ink fill; the on state is also in aria-pressed, never only in colour. */
export function Chip({ children, pressed, count, icon, className, ...rest }: ChipProps) {
  return (
    <Pressable {...rest} aria-pressed={pressed} className={cx(styles.chip, className)} data-on={pressed ? 'true' : undefined}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.label}>{children}</span>
      {/* The space keeps the chip's name readable: "Open 12", not "Open12" */}
      {count !== undefined ? <> <span className={styles.count}>{count}</span></> : null}
    </Pressable>
  );
}
