import type { ComingWith, SetupItemView } from '@roofline/shared';
import { Button } from '@roofline/ui';
import { useState, type ReactNode } from 'react';
import { comingWith, setup, setupItems } from '../../copy/setup.ts';
import { CompanyBasicsSheet } from './CompanyBasicsSheet.tsx';
import { useSkip, useUnskip } from './api.ts';
import styles from './SetupRow.module.css';

type SetupRowProps = {
  item: SetupItemView;
  canAct: boolean;
};

/** The chip's words: a later-spec item says what it comes with; a rejected registration says so. */
function chipText(item: SetupItemView, later: ComingWith | null): string {
  if (later) return comingWith[later];
  if (item.data.rejected === true) return setup.chips.rejected;
  return setup.chips[item.status];
}

/** One checklist step: its title, what it is for, what it unlocks, its status and the action that moves it on. */
export function SetupRow({ item, canAct }: SetupRowProps) {
  const copy = setupItems[item.key];
  const [sheetOpen, setSheetOpen] = useState(false);
  const skip = useSkip();
  const unskip = useUnskip();

  // The calendar step is live now: the server still says it comes later, and the row ignores that
  const later = item.key === 'connect_calendar' ? null : item.comingWith;
  // Connecting the calendar is every member's own action, so it does not wait on the owner
  const offersActions = (canAct || item.key === 'connect_calendar') && later === null && item.status !== 'done';
  const rejected = item.data.rejected === true;

  let primary: ReactNode = null;
  if (offersActions) {
    switch (item.key) {
      case 'company_basics':
        primary = (
          <Button variant="primary" onClick={() => setSheetOpen(true)}>
            {setup.actions.checkDetails}
          </Button>
        );
        break;
      case 'import_customers':
        primary = (
          <Button variant="primary" href="/settings/setup/import">
            {setup.actions.importCustomers}
          </Button>
        );
        break;
      case 'texting_registration':
        if (item.status !== 'waiting') {
          primary = (
            <Button variant="primary" href="/settings/setup/texting">
              {rejected ? setup.actions.fixAndResubmit : setup.actions.start}
            </Button>
          );
        }
        break;
      case 'invite_team':
        primary = (
          <Button variant="primary" href="/settings/team">
            {setup.actions.invite}
          </Button>
        );
        break;
      case 'payment_method':
        primary = (
          <Button variant="primary" href="/settings/billing">
            {setup.actions.addCard}
          </Button>
        );
        break;
      case 'connect_calendar':
        primary = (
          <Button variant="primary" href="/settings/connections">
            {setup.actions.connectCalendar}
          </Button>
        );
        break;
      default:
        primary = null;
    }
  }

  const skipping = item.status !== 'skipped';
  const skipAction =
    offersActions && item.skippable ? (
      skipping ? (
        <Button variant="ghost" busy={skip.isPending} onClick={() => skip.mutate(item.key)}>
          {setup.actions.skip}
        </Button>
      ) : (
        <Button variant="ghost" busy={unskip.isPending} onClick={() => unskip.mutate(item.key)}>
          {setup.actions.undoSkip}
        </Button>
      )
    ) : null;

  const chipStatus = later ? 'comingWith' : item.status;

  return (
    <li className={styles.row}>
      <div className={styles.header}>
        <h3 className={styles.title}>{copy.title}</h3>
        <span className={styles.chip} data-status={chipStatus}>
          {chipText(item, later)}
        </span>
      </div>
      <p className={styles.description}>{copy.description}</p>
      {copy.unlocks !== undefined ? <p className={styles.unlocks}>{copy.unlocks}</p> : null}
      {primary !== null || skipAction !== null ? (
        <div className={styles.actions}>
          {primary}
          {skipAction}
        </div>
      ) : null}
      {canAct && item.key === 'company_basics' ? (
        <CompanyBasicsSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
      ) : null}
    </li>
  );
}
