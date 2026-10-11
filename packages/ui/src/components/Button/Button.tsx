import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from '../../cx.ts';
import { Pressable } from '../../pressable.tsx';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and sets aria-busy while a request is running. */
  busy?: boolean;
  /** Draws a link styled as a button. Use the button attributes (type, form...) only without it. */
  href?: string;
  /** The rendered button, or the anchor when there is an href. */
  ref?: Ref<HTMLButtonElement | HTMLAnchorElement>;
};

export function Button({ variant = 'primary', size = 'md', className, ...rest }: ButtonProps) {
  return (
    <Pressable {...rest} className={cx(styles.button, className)} data-variant={variant} data-size={size} />
  );
}
