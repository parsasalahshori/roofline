import type { ButtonHTMLAttributes, HTMLAttributeAnchorTarget, Ref } from 'react';
import { cx } from '../../cx.ts';
import { Pressable } from '../../pressable.tsx';
import styles from './Button.module.css';

/**
 * primary: the company's colour, one per view. ink: graphite, for the strongest action on a busy screen.
 * default: a hairline button, the usual second choice. quiet: a filled-in-gray button for a tool. ghost: text only,
 * the quietest. danger: holds, deletes and anything that cannot be undone.
 */
export type ButtonVariant = 'primary' | 'ink' | 'default' | 'quiet' | 'ghost' | 'danger';
/** sm 30px, md 36px, lg 44px on a desktop; on a phone a thumb gets 44, 44 and 52. */
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and sets aria-busy while a request is running. */
  busy?: boolean;
  /** Draws a link styled as a button. Use the button attributes (type, form...) only without it. */
  href?: string;
  /** For a link: where it opens ("_blank" is another tab). */
  target?: HTMLAttributeAnchorTarget;
  /** For a link: what the page it opens may know about this one ("noopener noreferrer" for another site). */
  rel?: string;
  /**
   * For a quiet button that stands alone under a field or beside text ("+ Add another phone"): pulls the box out by its
   * own padding on that side, so its words line up with the content edge instead of sitting one padding inside it.
   */
  flush?: 'start' | 'end';
  /** The rendered button, or the anchor when there is an href. */
  ref?: Ref<HTMLButtonElement | HTMLAnchorElement>;
};

export function Button({ variant = 'primary', size = 'md', flush, className, ...rest }: ButtonProps) {
  return (
    <Pressable
      {...rest}
      className={cx(styles.button, className)}
      data-variant={variant}
      data-size={size}
      data-flush={flush}
    />
  );
}
