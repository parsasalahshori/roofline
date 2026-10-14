import { APPOINTMENT_KINDS, DEFAULT_DURATION_MINUTES, type AppointmentKind } from '@roofline/shared';
import { useQuery } from '@tanstack/react-query';
import { Banner, Button, Field, Select, Skeleton, useToast } from '@roofline/ui';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, apiFetch } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import type { Account } from '../../api/types.ts';
import { appointments } from '../../copy/appointments.ts';
import { addZonedDays, dateKeyToInstant, zonedDateKey, zonedParts, zoneName } from '../calendar/time.ts';
import { useCompany, useTeam } from '../settings/api.ts';
import { ConflictWarnings } from './ConflictWarnings.tsx';
import { SuggestedTimes } from './SuggestedTimes.tsx';
import { useCreateAppointment, useUpdateAppointment } from './api.ts';
import styles from './AppointmentForm.module.css';
import type { AppointmentBody, AppointmentFormProps, SaveResult, Slot } from './types.ts';

/** The zone used until the company's own zone has loaded (and when it fails to load). */
const FALLBACK_ZONE = 'America/Chicago';

/** Kinds that get suggested times. An install is a set of days, so it never gets them. */
const SUGGESTED_KINDS: ReadonlyArray<AppointmentKind> = ['inspection', 'adjuster', 'other'];

/** GET /api/search?q= (only the fields the form reads). */
type SearchCustomer = { id: string; displayName: string };
type SearchJob = { id: string; customerId: string; customerName: string; propertyId: string; addressLine: string };
type SearchBody = { customers: SearchCustomer[]; jobs: SearchJob[] };

/** GET /api/jobs/:id/view (the fields the form reads). */
type JobViewBody = {
  job: { id: string };
  customer: { id: string; displayName: string };
  home: { id: string; addressLine: string };
};

/** GET /api/customers/:id (the fields the form reads). */
type CustomerBody = { id: string; displayName: string };

/** What the customer or job line holds. A job fixes its customer and home; a customer alone clears the job and home. */
type Picked = {
  jobId: string | null;
  customerId: string | null;
  propertyId: string | null;
  customerName: string | null;
  addressLine: string | null;
};

const NOTHING_PICKED: Picked = { jobId: null, customerId: null, propertyId: null, customerName: null, addressLine: null };

const pad2 = (value: number): string => String(value).padStart(2, '0');

function isKind(value: string | null): value is AppointmentKind {
  return value !== null && (APPOINTMENT_KINDS as readonly string[]).includes(value);
}

/** Wall clock of `instant` in `zone`, read as if it were UTC (milliseconds). */
function wallMillis(instant: number, zone: string): number {
  const p = zonedParts(new Date(instant), zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/**
 * The instant at which the zone's wall clock reads `dateKey` ("YYYY-MM-DD") and `hhmm` ("HH:MM").
 * The zone offset is looked up twice, so the 23- and 25-hour days of a DST change land on the right instant.
 */
export function zonedWallToInstant(dateKey: string, hhmm: string, zone: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const clock = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (day === null || clock === null) throw new RangeError(`Not a day and time: ${dateKey} ${hhmm}`);
  const wall = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), Number(clock[1]), Number(clock[2]));
  const first = wall - (wallMillis(wall, zone) - wall);
  return new Date(wall - (wallMillis(first, zone) - first));
}

/** "HH:MM" of `date` on the zone's wall clock. */
function hhmmOf(date: Date, zone: string): string {
  const p = zonedParts(date, zone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

type FormBodyProps = AppointmentFormProps & { account: Account; zone: string };

/** The new or reschedule form. It waits for the signed-in person and the company's zone, so every date starts in the right zone. */
export function AppointmentForm(props: AppointmentFormProps) {
  const me = useMe();
  const company = useCompany();
  if (me.data === undefined || company.isPending) return <Skeleton height="8rem" />;
  return <FormBody {...props} account={me.data} zone={company.data?.timezone ?? FALLBACK_ZONE} />;
}

function FormBody({ existing, onDone, account, zone }: FormBodyProps) {
  const { user, role } = account;
  const isRep = role === 'rep';
  const [params] = useSearchParams();
  const toast = useToast();
  const team = useTeam();

  // A new appointment may start from a job or customer in the query; a reschedule starts from the appointment
  const jobParam = existing === undefined ? params.get('jobId') : null;
  const customerParam = existing === undefined && jobParam === null ? params.get('customerId') : null;
  const queryKind = existing === undefined ? params.get('kind') : null;

  const [kind, setKind] = useState<AppointmentKind>(existing?.kind ?? (isKind(queryKind) ? queryKind : 'inspection'));
  // What the person chose (null until they choose); until then the query's prefill applies
  const [chosen, setChosen] = useState<Picked | null>(() =>
    existing
      ? {
          jobId: existing.jobId,
          customerId: existing.customerId,
          propertyId: existing.propertyId,
          customerName: existing.customerName,
          addressLine: existing.addressLine,
        }
      : null,
  );

  const [query, setQuery] = useState('');
  const search = query.trim();
  const results = useQuery({
    queryKey: ['appointments', 'search', search],
    queryFn: ({ signal }) => apiFetch<SearchBody>('/api/search?q=' + encodeURIComponent(search), { signal }),
    enabled: search.length >= 2,
  });

  const jobView = useQuery({
    queryKey: ['appointments', 'job', jobParam],
    queryFn: ({ signal }) => apiFetch<JobViewBody>(`/api/jobs/${encodeURIComponent(jobParam ?? '')}/view`, { signal }),
    enabled: jobParam !== null && jobParam !== '',
  });
  const customerView = useQuery({
    queryKey: ['appointments', 'customer', customerParam],
    queryFn: ({ signal }) => apiFetch<CustomerBody>(`/api/customers/${encodeURIComponent(customerParam ?? '')}`, { signal }),
    enabled: customerParam !== null && customerParam !== '',
  });

  const fromQuery: Picked | null =
    jobView.data !== undefined
      ? {
          jobId: jobView.data.job.id,
          customerId: jobView.data.customer.id,
          propertyId: jobView.data.home.id,
          customerName: jobView.data.customer.displayName,
          addressLine: jobView.data.home.addressLine,
        }
      : customerView.data !== undefined
        ? { ...NOTHING_PICKED, customerId: customerView.data.id, customerName: customerView.data.displayName }
        : null;
  const picked = chosen ?? fromQuery ?? NOTHING_PICKED;

  const pickJob = (job: SearchJob) => {
    setChosen({ jobId: job.id, customerId: job.customerId, propertyId: job.propertyId, customerName: job.customerName, addressLine: job.addressLine });
    setQuery('');
  };
  const pickCustomer = (customer: SearchCustomer) => {
    setChosen({ ...NOTHING_PICKED, customerId: customer.id, customerName: customer.displayName });
    setQuery('');
  };
  const clearPicked = () => {
    setChosen(NOTHING_PICKED);
    setQuery('');
  };

  // Person: a rep is always themselves; the owner and office start on themselves and may pick anyone (or '' = Anyone)
  const peopleParam = existing === undefined ? (params.get('people') ?? '') : '';
  const queryPerson = !isRep && peopleParam !== '' && !peopleParam.includes(',') ? peopleParam : null;
  const [assigned, setAssigned] = useState<string>(existing ? (existing.assigned?.userId ?? '') : (queryPerson ?? user.id));
  const person = isRep ? user.id : assigned;
  const memberOptions = (team.data?.members ?? [])
    .filter((member) => member.status === 'active')
    .map((member) => ({ value: member.userId, label: member.name }));
  if (!memberOptions.some((option) => option.value === user.id)) memberOptions.unshift({ value: user.id, label: user.name });
  const personOptions = isRep
    ? [{ value: user.id, label: user.name }]
    : [{ value: '', label: appointments.anyone }, ...memberOptions];

  // Date and time, in the company zone
  // A new appointment may start from a clicked calendar slot (?start=<iso>)
  const startParam = existing === undefined ? params.get('start') : null;
  const queryStart = startParam === null ? null : new Date(startParam);
  const slotStart = queryStart !== null && Number.isFinite(queryStart.getTime()) ? queryStart : null;
  const [date, setDate] = useState<string>(() =>
    existing ? zonedDateKey(new Date(existing.startsAt), zone) : zonedDateKey(slotStart ?? new Date(), zone),
  );
  const [time, setTime] = useState<string>(() => {
    if (existing) return !existing.allDay ? hhmmOf(new Date(existing.startsAt), zone) : '';
    return slotStart !== null ? hhmmOf(slotStart, zone) : '';
  });
  // An install's end date; '' means the same day as the start
  const [endDate, setEndDate] = useState<string>(() =>
    existing?.allDay ? zonedDateKey(new Date(Date.parse(existing.endsAt) - 1), zone) : '',
  );
  const endKey = endDate === '' ? date : endDate;
  const isInstall = kind === 'install';
  const canSave = isInstall ? date !== '' && endKey >= date : date !== '' && time !== '';

  const [notes, setNotes] = useState<string>(existing?.notes ?? '');

  // Save: the first save creates; a save after the warnings were kept (or changed) updates the saved one
  const [savedId, setSavedId] = useState<string | null>(null);
  const [warned, setWarned] = useState<SaveResult | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const targetId = savedId ?? existing?.id ?? null;
  const create = useCreateAppointment();
  const update = useUpdateAppointment(targetId ?? '');
  const saving = create.isPending || update.isPending;

  const startsAtOf = (): AppointmentBody => {
    if (kind === 'install') {
      return {
        kind,
        allDay: true,
        startsAt: dateKeyToInstant(date, zone).toISOString(),
        endsAt: addZonedDays(dateKeyToInstant(endKey, zone), 1, zone).toISOString(),
      };
    }
    const start = zonedWallToInstant(date, time, zone);
    // Keep the length of the appointment being moved; otherwise the kind's default length
    const lengthMs =
      existing !== undefined && !existing.allDay && existing.kind === kind
        ? Date.parse(existing.endsAt) - Date.parse(existing.startsAt)
        : DEFAULT_DURATION_MINUTES[kind] * 60_000;
    return { kind, allDay: false, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + lengthMs).toISOString() };
  };

  const buildBody = (): AppointmentBody => {
    const body = startsAtOf();
    const trimmedNotes = notes.trim();
    if (targetId !== null) {
      // A PATCH states every link, so an emptied one is cleared with null
      return {
        ...body,
        jobId: picked.jobId,
        customerId: picked.customerId,
        propertyId: picked.propertyId,
        assignedUserId: person === '' ? null : person,
        notes: trimmedNotes === '' ? null : trimmedNotes,
      };
    }
    if (picked.jobId !== null) body.jobId = picked.jobId;
    if (picked.customerId !== null) body.customerId = picked.customerId;
    if (picked.propertyId !== null) body.propertyId = picked.propertyId;
    if (person !== '') body.assignedUserId = person;
    if (trimmedNotes !== '') body.notes = trimmedNotes;
    return body;
  };

  const save = async () => {
    setSaveFailed(false);
    try {
      const body = buildBody();
      const result = targetId === null ? await create.mutateAsync(body) : await update.mutateAsync(body);
      setSavedId(result.appointment.id);
      if (result.jobMoved === true) toast.show(appointments.jobMoved, 'success');
      if (result.warnings.length > 0) {
        setWarned(result);
        return;
      }
      onDone(result.appointment);
    } catch (error) {
      setSaveError(error instanceof ApiError && error.message !== '' ? error.message : null);
      setSaveFailed(true);
    }
  };

  const pickSlot = (slot: Slot, who: string) => {
    const when = new Date(slot.start);
    setDate(zonedDateKey(when, zone));
    setTime(hhmmOf(when, zone));
    setAssigned(who);
  };

  const kindOptions = APPOINTMENT_KINDS.map((option) => ({ value: option, label: appointments.kind[option] }));
  const hasPicked = picked.customerId !== null || picked.jobId !== null;
  const matches = results.data;

  return (
    <div className={styles.form}>
      <h2 className={styles.title}>{existing ? appointments.rescheduleTitle : appointments.newTitle}</h2>
      <p className={styles.intro}>{appointments.formHint}</p>

      <Select
        label={appointments.kindLabel}
        value={kind}
        onChange={(value) => {
          if (isKind(value)) setKind(value);
        }}
        options={kindOptions}
      />

      {hasPicked ? (
        <div className={styles.picked}>
          <div className={styles.pickedText}>
            <span className={styles.pickedName}>{picked.customerName}</span>
            {picked.addressLine !== null ? (
              <span className={styles.muted}>
                <span>{appointments.homeLabel}</span> <span>{picked.addressLine}</span>
              </span>
            ) : null}
          </div>
          <Button type="button" variant="ghost" onClick={clearPicked}>
            {appointments.customerClear}
          </Button>
        </div>
      ) : (
        <div className={styles.typeahead}>
          <Field
            label={appointments.customerLabel}
            placeholder={appointments.customerPlaceholder}
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          {search.length >= 2 && matches !== undefined ? (
            <ul className={styles.results} aria-label={appointments.customerResults}>
              {matches.customers.map((customer) => (
                <li key={`customer-${customer.id}`}>
                  <Button type="button" variant="ghost" className={styles.option} onClick={() => pickCustomer(customer)}>
                    <span className={styles.optionName}>{customer.displayName}</span>
                  </Button>
                </li>
              ))}
              {matches.jobs.map((job) => (
                <li key={`job-${job.id}`}>
                  <Button type="button" variant="ghost" className={styles.option} onClick={() => pickJob(job)}>
                    <span className={styles.optionName}>{job.customerName}</span>
                    <span className={styles.muted}>{job.addressLine}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <Select label={appointments.personLabel} value={person} onChange={setAssigned} options={personOptions} disabled={isRep} />

      <div className={styles.dates}>
        {isInstall ? (
          <>
            <Field type="date" label={appointments.startDateLabel} value={date} onChange={(event) => setDate(event.target.value)} />
            <Field type="date" label={appointments.endDateLabel} value={endKey} onChange={(event) => setEndDate(event.target.value)} />
          </>
        ) : (
          <>
            <Field type="date" label={appointments.dateLabel} value={date} onChange={(event) => setDate(event.target.value)} />
            <Field type="time" label={appointments.timeLabel} value={time} onChange={(event) => setTime(event.target.value)} />
          </>
        )}
      </div>
      <p className={styles.muted}>{appointments.timeZone(zoneName(zone))}</p>

      {SUGGESTED_KINDS.includes(kind) ? (
        <SuggestedTimes
          kind={kind}
          userId={person}
          propertyId={picked.propertyId ?? ''}
          zone={zone}
          onPick={pickSlot}
        />
      ) : null}

      <Field
        label={appointments.notesLabel}
        multiline
        rows={3}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />

      {saveFailed ? <Banner tone="danger">{saveError ?? appointments.saveError}</Banner> : null}

      {warned !== null ? (
        <ConflictWarnings
          warnings={warned.warnings}
          onKeep={() => onDone(warned.appointment)}
          onChange={() => setWarned(null)}
        />
      ) : (
        <div className={styles.actions}>
          <Button type="button" disabled={!canSave || saving} onClick={() => void save()}>
            {saving ? appointments.saving : appointments.save}
          </Button>
        </div>
      )}
    </div>
  );
}

