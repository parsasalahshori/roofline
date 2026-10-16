import type { ComingWith, SetupItemKey, SetupItemView } from '@roofline/shared';
import { Button, Tag, type IconName, type TagTone } from '@roofline/ui';
import { useState } from 'react';
import { comingWith, setup, setupItems } from '../../copy/setup.ts';
import { CompanyBasicsSheet } from './CompanyBasicsSheet.tsx';
import { useSkip, useUnskip } from './api.ts';
import styles from './SetupRow.module.css';

type SetupRowProps = {
  item: SetupItemView;
  canAct: boolean;
  /** The step to do next: its action is the one primary button of the checklist. */
  next?: boolean;
};

/** Where each step leads: a page, or the sheet that opens over this one (the company on the map). */
const TARGETS: Record<SetupItemKey, { href: string } | 'sheet'> = {
  company_basics: 'sheet',
  import_customers: { href: '/settings/setup/import' },
  texting_registration: { href: '/settings/setup/texting' },
  invite_team: { href: '/settings/team' },
  payment_method: { href: '/settings/billing' },
  prices_and_tiers: { href: '/settings/prices' },
  connect_calendar: { href: '/settings/connections' },
  phone_number: { href: '/settings/front-desk#forwarding' },
  connect_ads: { href: '/settings/connections' },
};

/** The words on a step's action while it is still to do. */
function actionLabel(key: SetupItemKey, rejected: boolean): string {
  switch (key) {
    case 'company_basics':
      return setup.actions.checkDetails;
    case 'import_customers':
      return setup.actions.importCustomers;
    case 'texting_registration':
      return rejected ? setup.actions.fixAndResubmit : setup.actions.start;
    case 'invite_team':
      return setup.actions.invite;
    case 'payment_method':
      return setup.actions.addCard;
    case 'prices_and_tiers':
      return setup.actions.setPrices;
    case 'connect_calendar':
      return setup.actions.connectCalendar;
    case 'phone_number':
      return setup.actions.forwardCalls;
    case 'connect_ads':
      return setup.actions.connectAds;
  }
}

/** How a step's state looks as a tag: a colour and a glyph beside its words, never a colour alone. */
type Look = 'todo' | 'in_progress' | 'done' | 'skipped' | 'waiting' | 'rejected' | 'later';
const LOOKS: Record<Look, { tone: TagTone; icon: IconName }> = {
  todo: { tone: 'neutral', icon: 'dots' },
  in_progress: { tone: 'info', icon: 'pen' },
  done: { tone: 'ok', icon: 'check' },
  skipped: { tone: 'neutral', icon: 'minus' },
  waiting: { tone: 'warn', icon: 'clock' },
  rejected: { tone: 'bad', icon: 'alert' },
  later: { tone: 'neutral', icon: 'clock' },
};

/** The tag's words: a later-spec item says what it comes with; a rejected registration says so. */
function tagText(item: SetupItemView, later: ComingWith | null): string {
  if (later) return comingWith[later];
  if (item.data.rejected === true) return setup.chips.rejected;
  return setup.chips[item.status];
}

/** One checklist step: its title, what it is for, what it unlocks, its status tag and the action that moves it on. */
export function SetupRow({ item, canAct, next = false }: SetupRowProps) {
  const copy = setupItems[item.key];
  const [sheetOpen, setSheetOpen] = useState(false);
  const skip = useSkip();
  const unskip = useUnskip();

  // The calendar step (C1), the phone number step (D1, the forwarding guide) and the ad accounts step (S1)
  // are live now: an older server may still say they come later, and the row ignores that
  const later = item.key === 'connect_calendar' || item.key === 'phone_number' || item.key === 'connect_ads' ? null : item.comingWith;
  // Connecting the calendar is every member's own action, so it does not wait on the owner
  const mayAct = (canAct || item.key === 'connect_calendar') && later === null;
  const offersActions = mayAct && item.status !== 'done';
  const rejected = item.data.rejected === true;
  // A registration waiting on the phone carriers has nothing to press, but it can still be looked at
  const todoAction = offersActions && !(item.key === 'texting_registration' && item.status === 'waiting');
  const reviewAction = mayAct && !todoAction && (item.status === 'done' || item.status === 'waiting');

  const target = TARGETS[item.key];
  /** The button or link to the step's place: filled for the step to do next, outlined for the others, quiet for a review. */
  const goTo = (label: string, variant: 'primary' | 'default' | 'ghost', ariaLabel?: string) =>
    target === 'sheet' ? (
      <Button variant={variant} aria-label={ariaLabel} onClick={() => setSheetOpen(true)}>
        {label}
      </Button>
    ) : (
      <Button variant={variant} aria-label={ariaLabel} href={target.href}>
        {label}
      </Button>
    );

  let primary = null;
  if (todoAction) primary = goTo(actionLabel(item.key, rejected), next ? 'primary' : 'default');
  else if (reviewAction) primary = goTo(setup.actions.review, 'ghost', setup.actions.reviewFor(copy.title));

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

  const look: Look = later ? 'later' : rejected ? 'rejected' : item.status;
  const { tone, icon } = LOOKS[look];

  return (
    <li className={styles.row} data-status={look}>
      <div className={styles.main}>
        <h3 className={styles.title}>{copy.title}</h3>
        <p className={styles.description}>{copy.description}</p>
        {copy.unlocks !== undefined ? <p className={styles.unlocks}>{copy.unlocks}</p> : null}
      </div>
      <div className={styles.status}>
        <Tag tone={tone} icon={icon} className={styles.tag}>
          {tagText(item, later)}
        </Tag>
      </div>
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
