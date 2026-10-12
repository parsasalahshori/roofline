import type { JobView, MemberRef } from '@roofline/shared';
import { Button, Pill, Select, UiLink, useToast, type SelectOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { job } from '../../copy/job.ts';
import { useTeam } from '../settings/api.ts';
import { MoveJobMenu } from '../jobs/MoveJobMenu.tsx';
import { useUpdateJob } from './api.ts';
import { StageStepper } from './StageStepper.tsx';
import styles from './JobHeader.module.css';

export type JobHeaderProps = { view: JobView; onEdit: () => void };

/** A calendar day (YYYY-MM-DD) as "Oct 14, 2026". It is a date, not an instant, so it is read in UTC and never shifted. */
const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
function formatDay(ymd: string): string {
  const instant = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(instant) ? ymd : dayFormat.format(new Date(instant));
}

/**
 * The top of the job: who and where, the stage, the Move-to menu, the rep and the next step.
 * A rep picks from themselves and Unassigned only; everyone else from the active team.
 */
export function JobHeader({ view, onEdit }: JobHeaderProps) {
  const { job: current, customer, home, can } = view;
  const me = useMe();
  const team = useTeam();
  const update = useUpdateJob(current.id);
  const toast = useToast();

  // A rep, or anyone whose team list is not in, chooses from themselves and the current assignee only
  const seeWholeTeam = me.data !== undefined && me.data.role !== 'rep' && team.data !== undefined;
  const people: MemberRef[] = [];
  if (seeWholeTeam && team.data !== undefined) {
    for (const member of team.data.members) {
      if (member.status === 'active') people.push({ userId: member.userId, name: member.name });
    }
  } else if (me.data !== undefined) {
    people.push({ userId: me.data.user.id, name: me.data.user.name });
  }
  if (current.assigned !== null && !people.some((person) => person.userId === current.assigned?.userId)) {
    people.push(current.assigned);
  }
  const repOptions: SelectOption[] = [
    { value: '', label: job.unassigned },
    ...people.map((person) => ({ value: person.userId, label: person.name })),
  ];

  async function changeRep(value: string) {
    try {
      await update.mutateAsync({ assignedUserId: value === '' ? null : value });
    } catch (error) {
      toast.show(error instanceof ApiError && error.message !== '' ? error.message : job.saveFailed, 'error');
    }
  }

  const nextLine =
    current.nextStep === null
      ? job.nextStepNone
      : current.nextStepOn === null
        ? current.nextStep
        : job.nextStepOn(current.nextStep, formatDay(current.nextStepOn));

  return (
    <header className={styles.header}>
      <div className={styles.places}>
        <h2 className={styles.customer}>
          <UiLink href={`/customers/${customer.id}`}>{customer.displayName}</UiLink>
        </h2>
        <p className={styles.address}>
          <UiLink href={`/?focus=${current.propertyId}`} aria-label={job.addressLink(home.addressLine)}>
            {home.addressLine}
          </UiLink>
        </p>
        {current.archived ? <Pill tone="neutral">{job.archivedChip}</Pill> : null}
      </div>

      <StageStepper job={current} canEdit={can.edit} />

      {can.edit ? <MoveJobMenu job={current} /> : null}

      <div className={styles.row}>
        <Select
          label={job.repLabel}
          value={current.assigned?.userId ?? ''}
          options={repOptions}
          disabled={!can.edit || update.isPending}
          onChange={(value) => {
            if (value !== (current.assigned?.userId ?? '')) void changeRep(value);
          }}
        />
      </div>

      <div className={styles.row}>
        <p className={styles.next}>
          <span className={styles.nextLabel}>{job.nextStepLabel}</span> <span>{nextLine}</span>
        </p>
        {can.edit ? (
          <Button variant="ghost" onClick={onEdit}>
            {job.edit}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
