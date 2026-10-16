import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../cx.ts';
import styles from './Panel.module.css';

export type PanelProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  /** The panel's heading. It also names the panel's region. */
  title?: ReactNode;
  /** An h2 by default; use 3 for a panel inside another panel's section. */
  headingLevel?: 2 | 3;
  /** A small label beside the title: a count, a status. */
  tag?: ReactNode;
  /** Controls at the right of the header. */
  actions?: ReactNode;
  /** Inner padding. Off for a table or a list that runs edge to edge. */
  padded?: boolean;
  as?: 'section' | 'div' | 'aside';
};

/** A surface with a hairline and a 10px radius: the one container the pages are made of. Its header is Archivo at 15px. */
export function Panel({ title, headingLevel = 2, tag, actions, padded = true, as: Tag = 'section', className, children, ...rest }: PanelProps) {
  const titleId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <Tag {...rest} className={cx(styles.panel, className)} aria-labelledby={title !== undefined ? titleId : rest['aria-labelledby']} data-padded={padded}>
      {hasHeader ? (
        <div className={styles.header}>
          {title !== undefined ? (
            <div className={styles.titles}>
              <Heading id={titleId} className={styles.title}>
                {title}
              </Heading>
              {tag ? <span className={styles.tag}>{tag}</span> : null}
            </div>
          ) : null}
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      <div className={styles.body}>{children}</div>
    </Tag>
  );
}
