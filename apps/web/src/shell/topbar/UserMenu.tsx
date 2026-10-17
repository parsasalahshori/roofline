import { Avatar, Button, Card, Sheet, useFocusTrap, useToast } from '@roofline/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMe, useSignOut, useSwitchCompany } from '../../api/hooks.ts';
import type { Account } from '../../api/types.ts';
import { common } from '../../copy/common.ts';
import { rail } from '../../copy/rail.ts';
import { shell } from '../../copy/shell.ts';
import { SetupRing } from '../../features/setup/SetupRing.tsx';
import { useIsPhone } from '../useIsPhone.ts';
import styles from './UserMenu.module.css';

/**
 * The signed-in person. `rail` is the foot of the left rail (initials, name and role, the menu opening upward, the setup
 * ring above it); `bar` is a phone page's head (just the initials, the menu a bottom sheet). The name is the button's
 * accessible name either way. Opens the account menu: a popover on desktop, a sheet on phone.
 */
export function UserMenu({ variant = 'bar' }: { variant?: 'rail' | 'bar' }) {
  const me = useMe();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // Desktop: Esc closes the popover and focus goes back to the name. On phone the Sheet traps focus itself.
  useFocusTrap(popoverRef, { active: open && !phone, onEscape: close });

  // Desktop: a press outside the menu closes it. Not on phone, where the sheet sits outside the root and
  // a press on one of its entries would close the menu before the entry is clicked.
  useEffect(() => {
    if (!open || phone) return;
    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, phone]);

  const account = me.data;
  if (!account) return null;

  return (
    <div ref={rootRef} className={styles.root} data-variant={variant}>
      <Button
        variant="ghost"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={account.user.name}
        onClick={() => setOpen((current) => !current)}
        className={styles.trigger}
      >
        <Avatar name={account.user.name} size={28} />
        {variant === 'rail' ? (
          <span className={styles.who}>
            <b className={styles.name}>{account.user.name}</b>
            <small className={styles.role}>{rail.roles[account.role]}</small>
          </span>
        ) : null}
      </Button>
      {variant === 'rail' ? (
        <div className={styles.setup}>
          <SetupRing />
        </div>
      ) : null}
      {open && !phone ? (
        <div ref={popoverRef} tabIndex={-1} className={styles.popover}>
          <Card as="section" padded={false} aria-label={shell.menuLabel}>
            <MenuList account={account} close={close} />
          </Card>
        </div>
      ) : null}
      <Sheet open={open && phone} title={shell.menuLabel} onClose={close} closeLabel={common.close}>
        <MenuList account={account} close={close} />
      </Sheet>
    </div>
  );
}

/** The menu's entries. The same list is shown in the desktop popover and in the phone sheet. */
function MenuList({ account, close }: { account: Account; close: () => void }) {
  const toast = useToast();
  const switchCompany = useSwitchCompany();
  const signOut = useSignOut();
  // Only other companies: switching to the one already open would do nothing
  const others = account.companies.length > 1 ? account.companies.filter((company) => company.id !== account.company.id) : [];

  return (
    <ul className={styles.list}>
      <li>
        <Button variant="ghost" href="/today" onClick={close} className={styles.item}>
          {shell.myDay}
        </Button>
      </li>
      <li>
        <Button variant="ghost" href="/settings/company" onClick={close} className={styles.item}>
          {shell.settings}
        </Button>
      </li>
      {others.map((company) => (
        <li key={company.id}>
          <Button
            variant="ghost"
            busy={switchCompany.isPending}
            className={styles.item}
            /* The hook goes to the map and reports a failure, even once this menu has closed */
            onClick={() => switchCompany.mutate(company.id, { onSuccess: close })}
          >
            {shell.switchTo(company.name)}
          </Button>
        </li>
      ))}
      <li>
        <Button
          variant="ghost"
          busy={signOut.isPending}
          className={styles.item}
          onClick={() =>
            signOut.mutate(undefined, {
              onError: (error) => toast.show(error.message, 'error'),
            })
          }
        >
          {shell.signOut}
        </Button>
      </li>
    </ul>
  );
}
