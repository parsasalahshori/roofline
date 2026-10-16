import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../cx.ts';
import { Icon, type IconName } from '../../icons.tsx';
import styles from './Tag.module.css';

/** neutral: plain. brand: the company's colour. tape: needs your OK or being measured. ok / warn / bad / info: status. */
export type TagTone = 'neutral' | 'brand' | 'tape' | 'ok' | 'warn' | 'bad' | 'info';

export type TagProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  children: ReactNode;
  tone?: TagTone;
  /** A status is never only a colour: give the tag its glyph as well as its word. */
  icon?: IconName;
};

/** A 22px label with a 4px radius: a status, a stage, a method. Its text is the status colour mixed toward ink so it stays AA on its tint. */
export function Tag({ children, tone = 'neutral', icon, className, ...rest }: TagProps) {
  return (
    <span {...rest} className={cx(styles.tag, className)} data-tone={tone}>
      {icon ? <Icon name={icon} size={16} className={styles.icon} /> : null}
      {children}
    </span>
  );
}
