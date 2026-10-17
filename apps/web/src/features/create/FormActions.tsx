import type { ReactNode } from 'react';
import { useIsPhone } from '../../shell/useIsPhone.ts';

/**
 * The buttons at the foot of a create form. With room beside them the main action comes first, under the last field; on a phone
 * the row is a bar that stays at the bottom edge, and there the way out is on the left and the main action on the right, under
 * the thumb, like every other bar on a phone (the calendar's form, a plan's decision bar).
 */
export function FormActions({ save, cancel, className }: { save: ReactNode; cancel: ReactNode; className: string }) {
  const phone = useIsPhone();
  return (
    <div className={className}>
      {phone ? cancel : save}
      {phone ? save : cancel}
    </div>
  );
}
