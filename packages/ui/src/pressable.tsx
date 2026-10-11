import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEventHandler } from 'react';
import { UiLink } from './link.tsx';

export type PressableProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Renders a link (through UiLink) instead of a button. */
  href?: string;
  /** Work in progress: the control stays on screen but cannot be used again until it finishes. */
  busy?: boolean;
};

/**
 * What Button, IconButton and Pill share: a <button type="button"> by default, a UiLink when given
 * an href. A link cannot be `disabled`, so while busy or disabled it carries aria-disabled and
 * swallows the click, which stops the navigation.
 */
export function Pressable({ href, busy = false, disabled = false, type = 'button', onClick, ...rest }: PressableProps) {
  const inactive = busy || disabled;
  const ariaBusy = busy ? true : undefined;

  if (href !== undefined) {
    return (
      <UiLink
        {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}
        href={href}
        aria-busy={ariaBusy}
        aria-disabled={inactive ? true : undefined}
        onClick={(event) => {
          if (inactive) {
            event.preventDefault();
            return;
          }
          (onClick as MouseEventHandler<HTMLAnchorElement> | undefined)?.(event);
        }}
      />
    );
  }

  return <button {...rest} type={type} disabled={inactive} aria-busy={ariaBusy} onClick={onClick} />;
}
