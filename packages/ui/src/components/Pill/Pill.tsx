import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Chip } from '../Chip/Chip.tsx';
import { Tag } from '../Tag/Tag.tsx';

export type PillTone = 'accent' | 'neutral';

export type PillProps = {
  children: ReactNode;
  /** A link when given, a button when there is an onClick, a plain label otherwise. */
  href?: string;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
  tone?: PillTone;
};

/**
 * The older name for a small label or a link chip. A label is a Tag (accent is the company colour, neutral plain) and
 * something you can press is a Chip. New code uses Tag and Chip directly.
 */
export function Pill({ children, href, onClick, tone = 'accent' }: PillProps) {
  if (href !== undefined || onClick !== undefined) {
    return (
      <Chip href={href} onClick={onClick}>
        {children}
      </Chip>
    );
  }
  return <Tag tone={tone === 'accent' ? 'brand' : 'neutral'}>{children}</Tag>;
}
