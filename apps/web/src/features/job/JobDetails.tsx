import { useMemo } from 'react';
import type { JobSource, JobView, MemberRef } from '@roofline/shared';
import { Avatar, Button, Icon, Listbox, Panel, UiLink, useToast, type ListboxOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { job } from '../../copy/job.ts';
import { jobs } from '../../copy/jobs.ts';
import { formatDollars } from '../jobs/format.ts';
import { useCompanyZone } from '../jobs/useCompanyToday.ts';
import { useTeam } from '../settings/api.ts';
import { useUpdateJob } from './api.ts';
import styles from './JobDetails.module.css';

export type JobDetailsProps = { view: JobView; onEdit: () => void; className?: string };

/** Who the job can be given to. A rep, or anyone whose team list is not in, picks from themselves and the current rep only. */
function usePeople(view: JobView): MemberRef[] {
  const me = useMe();
  const team = useTeam();
  const { job: current } = view;
  const people: MemberRef[] = [];
  if (me.data !== undefined && me.data.role !== 'rep' && team.data !== undefined) {
    for (const member of team.data.members) {
      if (member.status === 'active') people.push({ userId: member.userId, name: member.name });
    }
  } else if (me.data !== undefined) {
    people.push({ userId: me.data.user.id, name: me.data.user.name });
  }
  if (current.assigned !== null && !people.some((person) => person.userId === current.assigned?.userId)) {
    people.push(current.assigned);
  }
  return people;
}

/** What is known about the job and who it is for: the customer, how it came in, what it is worth and who has it. */
export function JobDetails({ view, onEdit, className }: JobDetailsProps) {
  const { job: current, customer, can } = view;
  const toast = useToast();
  const update = useUpdateJob(current.id);
  const people = usePeople(view);
  const zone = useCompanyZone();
  const dayFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: zone }), [zone]);

  const repOptions: ListboxOption[] = [
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

  const source: JobSource = current.source;
  const showValue = can.seeValue && current.valueCents !== null;

  return (
    <Panel
      title={job.detailsTitle}
      className={className}
      actions={
        can.edit ? (
          <Button variant="default" size="sm" onClick={onEdit}>
            <Icon name="pen" size={16} />
            {job.edit}
          </Button>
        ) : undefined
      }
    >
      <dl className={styles.facts}>
        <dt>{job.customerLabel}</dt>
        <dd>
          <UiLink href={`/customers/${customer.id}`} className={styles.link}>
            {customer.displayName}
          </UiLink>
        </dd>

        {customer.email !== null && customer.email !== '' ? (
          <>
            <dt>{job.emailLabel}</dt>
            <dd>
              <UiLink href={`mailto:${customer.email}`} className={styles.link}>
                {customer.email}
              </UiLink>
            </dd>
          </>
        ) : null}

        <dt>{job.sourceLabel}</dt>
        <dd>{jobs.source[source]}</dd>

        {showValue && current.valueCents !== null ? (
          <>
            <dt>{job.statValue}</dt>
            <dd className={styles.mono}>{formatDollars(current.valueCents)}</dd>
          </>
        ) : null}

        <dt>{job.sinceLabel}</dt>
        <dd className={styles.mono}>{dayFormat.format(new Date(current.stageChangedAt))}</dd>

        <dt>{job.createdLabel}</dt>
        <dd className={styles.mono}>{dayFormat.format(new Date(current.createdAt))}</dd>

        {!can.edit ? (
          <>
            <dt>{job.repLabel}</dt>
            <dd className={styles.person}>
              {current.assigned !== null ? (
                <>
                  <Avatar name={current.assigned.name} size={24} />
                  <span>{current.assigned.name}</span>
                </>
              ) : (
                <span className={styles.muted}>{job.unassigned}</span>
              )}
            </dd>
          </>
        ) : null}
      </dl>

      {can.edit ? (
        <div className={styles.rep}>
          <Listbox
            variant="chip"
            label={job.repLabel}
            value={current.assigned?.userId ?? ''}
            options={repOptions}
            disabled={update.isPending}
            onChange={(value) => {
              if (value !== (current.assigned?.userId ?? '')) void changeRep(value);
            }}
          />
        </div>
      ) : null}
    </Panel>
  );
}
