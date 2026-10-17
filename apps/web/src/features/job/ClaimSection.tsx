import { useId, useMemo, useState, type ReactNode } from 'react';
import { CLAIM_STATUSES, displayUsPhone, type ClaimStatus, type JobClaimResponse } from '@roofline/shared';
import { Button, Field, Icon, Listbox, Panel, Sheet, Skeleton, Tag, useToast, type IconName, type ListboxOption, type TagTone } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { claims } from '../../copy/claims.ts';
import { job } from '../../copy/job.ts';
import { claimPacketUrl, useBuildClaimPacket, useJobClaim, useSaveClaim, type ClaimEdit } from '../claims/api.ts';
import { formatDollars } from '../jobs/format.ts';
import { LoadError } from '../jobs/states.tsx';
import { useCompanyZone } from '../jobs/useCompanyToday.ts';
import styles from './ClaimSection.module.css';

const statusOptions: ListboxOption<ClaimStatus>[] = CLAIM_STATUSES.map((s) => ({ value: s, label: claims.status[s] }));

/** The claim's status tag: its tone and glyph. The word is the status; the glyph and tone only back it up. */
const STATUS_TAG: Record<ClaimStatus, { tone: TagTone; icon: IconName }> = {
  not_filed: { tone: 'neutral', icon: 'doc' },
  filed: { tone: 'info', icon: 'arrow' },
  adjuster_scheduled: { tone: 'info', icon: 'cal' },
  inspected: { tone: 'info', icon: 'check' },
  approved: { tone: 'ok', icon: 'check' },
  partly_approved: { tone: 'warn', icon: 'alert' },
  denied: { tone: 'warn', icon: 'x' },
  supplement_requested: { tone: 'warn', icon: 'doc' },
  closed: { tone: 'neutral', icon: 'lock' },
};

/** Dollars typed by a person to cents. Empty is null; anything else that is not an amount (zero allowed) is 'invalid'. */
function parseDollars(text: string): number | null | 'invalid' {
  const cleaned = text.trim().replace(/^\$/, '');
  if (cleaned === '') return null;
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(cleaned)) return 'invalid';
  const cents = Math.round(Number(cleaned.replace(/,/g, '')) * 100);
  return Number.isFinite(cents) ? cents : 'invalid';
}

function dollarsText(cents: number | null): string {
  return cents === null ? '' : String(cents / 100);
}

type FormValues = {
  insurer: string;
  claimNumber: string;
  dateOfLoss: string;
  status: ClaimStatus;
  adjusterName: string;
  adjusterPhone: string;
  adjusterEmail: string;
  deductible: string;
  notes: string;
};

type FormField = keyof FormValues;

const EMPTY_VALUES: FormValues = {
  insurer: '',
  claimNumber: '',
  dateOfLoss: '',
  status: 'not_filed',
  adjusterName: '',
  adjusterPhone: '',
  adjusterEmail: '',
  deductible: '',
  notes: '',
};

const TEXT_FIELDS = ['insurer', 'claimNumber', 'dateOfLoss', 'adjusterName', 'adjusterPhone', 'adjusterEmail', 'notes'] as const;

/** Server field names to the form field that shows the message. */
const SERVER_FIELD: Record<string, FormField> = {
  insurer: 'insurer',
  claimNumber: 'claimNumber',
  dateOfLoss: 'dateOfLoss',
  status: 'status',
  adjusterName: 'adjusterName',
  adjusterPhone: 'adjusterPhone',
  adjusterEmail: 'adjusterEmail',
  deductibleCents: 'deductible',
  notes: 'notes',
};

function initialValues(data: JobClaimResponse): FormValues {
  const { claim, intake } = data;
  if (claim !== null) {
    return {
      insurer: claim.insurer ?? '',
      claimNumber: claim.claimNumber ?? '',
      dateOfLoss: claim.dateOfLoss ?? '',
      status: claim.status,
      adjusterName: claim.adjusterName ?? '',
      adjusterPhone: claim.adjusterPhone ?? '',
      adjusterEmail: claim.adjusterEmail ?? '',
      deductible: dollarsText(claim.deductibleCents),
      notes: claim.notes ?? '',
    };
  }
  if (intake !== null) {
    return {
      ...EMPTY_VALUES,
      insurer: intake.insurer,
      claimNumber: intake.claimNumber ?? '',
      dateOfLoss: intake.dateOfLoss ?? '',
    };
  }
  return EMPTY_VALUES;
}

function textOrNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

type ClaimSheetProps = { jobId: string; data: JobClaimResponse; onClose: () => void };

/** The claim form. Only the fields that changed are sent (a first save sends everything filled in). */
function ClaimSheet({ jobId, data, onClose }: ClaimSheetProps) {
  const save = useSaveClaim(jobId);
  const toast = useToast();
  // Initial values are the baseline for the diff; with no claim yet the baseline is empty.
  const [initial] = useState(() => initialValues(data));
  const baseline = data.claim === null ? EMPTY_VALUES : initial;
  const [values, setValues] = useState<FormValues>(initial);
  const [errors, setErrors] = useState<Partial<Record<FormField, string>>>({});

  function setValue<K extends FormField>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function submit() {
    const edit: ClaimEdit = {};
    for (const key of TEXT_FIELDS) {
      const next = textOrNull(values[key]);
      if (next !== textOrNull(baseline[key])) edit[key] = next;
      // First save from an intake: the API fills any field left out from the intake, so a pre-filled
      // field the person cleared is sent as an explicit null.
      else if (data.claim === null && next === null && textOrNull(initial[key]) !== null) edit[key] = null;
    }
    if (values.status !== baseline.status) edit.status = values.status;
    const cents = parseDollars(values.deductible);
    if (cents === 'invalid') {
      setErrors({ deductible: claims.deductibleInvalid });
      return;
    }
    const before = parseDollars(baseline.deductible);
    if (cents !== before) edit.deductibleCents = cents;

    if (Object.keys(edit).length === 0) {
      onClose();
      return;
    }
    try {
      await save.mutateAsync(edit);
    } catch (error) {
      const field = error instanceof ApiError && error.field !== undefined ? SERVER_FIELD[error.field] : undefined;
      if (field !== undefined && error instanceof ApiError) {
        setErrors({ [field]: error.message });
        return;
      }
      toast.show(claims.saveFailed, 'error');
      return;
    }
    toast.show(claims.saved, 'success');
    onClose();
  }

  const footer = (
    <div className={styles.footer}>
      <Button variant="quiet" onClick={onClose}>
        {claims.cancel}
      </Button>
      <Button variant="primary" busy={save.isPending} onClick={() => void submit()}>
        {claims.save}
      </Button>
    </div>
  );

  function textField(key: (typeof TEXT_FIELDS)[number], label: string, extra?: { type?: string; multiline?: boolean }) {
    return (
      <Field
        label={label}
        type={extra?.type}
        multiline={extra?.multiline}
        value={values[key]}
        error={errors[key]}
        onChange={(event) => setValue(key, event.currentTarget.value)}
      />
    );
  }

  return (
    <Sheet open title={claims.formTitle} onClose={onClose} closeLabel={claims.close} footer={footer}>
      <div className={styles.sheetBody}>
        {textField('insurer', claims.insurerLabel)}
        {textField('claimNumber', claims.claimNumberLabel)}
        {textField('dateOfLoss', claims.dateOfLossLabel, { type: 'date' })}
        <Listbox
          label={claims.statusLabel}
          value={values.status}
          options={statusOptions}
          error={errors.status}
          onChange={(next) => setValue('status', next)}
        />
        {textField('adjusterName', claims.adjusterNameLabel)}
        {textField('adjusterPhone', claims.adjusterPhoneLabel)}
        {textField('adjusterEmail', claims.adjusterEmailLabel)}
        <Field
          label={claims.deductibleLabel}
          help={claims.deductibleHelp}
          inputMode="decimal"
          value={values.deductible}
          error={errors.deductible}
          onChange={(event) => setValue('deductible', event.currentTarget.value)}
        />
        {textField('notes', claims.notesLabel, { multiline: true })}
      </div>
    </Sheet>
  );
}

/** G1 Task 7: the packet button (busy while it builds, an error toast on failure) and the download link. */
function PacketActions({ jobId, packet, dayFormat }: { jobId: string; packet: JobClaimResponse['packet']; dayFormat: Intl.DateTimeFormat }) {
  const build = useBuildClaimPacket(jobId);
  const toast = useToast();
  function run() {
    build.mutate(undefined, { onError: () => toast.show(claims.packetError, 'error') });
  }
  return (
    <>
      <Button variant="default" size="sm" busy={build.isPending} onClick={run}>
        {build.isPending ? claims.buildingPacket : claims.buildPacket}
      </Button>
      {packet != null ? (
        <a className={styles.link} href={claimPacketUrl(jobId)} target="_blank" rel="noreferrer">
          {claims.downloadPacket(dayFormat.format(new Date(packet.builtAt)))}
        </a>
      ) : null}
    </>
  );
}

type Row = { label: string; value: string; wide?: boolean };

/** The job's insurance claim: its status, details and history, with a form to add or edit them. */
export function ClaimSection({ jobId, className }: { jobId: string; className?: string }) {
  const zone = useCompanyZone();
  const query = useJobClaim(jobId);
  const [editing, setEditing] = useState(false);

  const dateFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }), []);
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }),
    [zone],
  );

  function dateOfLossText(ymd: string): string {
    const instant = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(instant) ? ymd : dateFormat.format(new Date(instant));
  }

  const data = query.data;
  const claim = data?.claim ?? null;
  let body: ReactNode;

  if (query.isPending) {
    body = (
      <div role="status" aria-label={claims.loading}>
        <Skeleton lines={3} />
      </div>
    );
  } else if (data === undefined) {
    body = <LoadError tag={job.errorTag} title={claims.loadError} retry={job.retry} busy={query.isFetching} onRetry={() => void query.refetch()} />;
  } else if (claim === null) {
    body = (
      <>
        <p className={styles.text}>{data.intake === null ? claims.none : claims.intakeLine(data.intake.insurer, data.intake.claimNumber)}</p>
        <div className={styles.actions}>
          <Button variant="default" size="sm" onClick={() => setEditing(true)}>
            <Icon name="plus" size={16} />
            {claims.addDetails}
          </Button>
        </div>
      </>
    );
  } else {
    const rows: Row[] = [];
    if (claim.insurer !== null) rows.push({ label: claims.insurerLabel, value: claim.insurer });
    if (claim.claimNumber !== null) rows.push({ label: claims.claimNumberLabel, value: claim.claimNumber });
    if (claim.dateOfLoss !== null) rows.push({ label: claims.dateOfLossLabel, value: dateOfLossText(claim.dateOfLoss) });
    if (claim.deductibleCents !== null) rows.push({ label: claims.deductibleLabel, value: formatDollars(claim.deductibleCents) });
    if (claim.adjusterName !== null) rows.push({ label: claims.adjusterNameLabel, value: claim.adjusterName });
    if (claim.adjusterPhone !== null) rows.push({ label: claims.adjusterPhoneLabel, value: displayUsPhone(claim.adjusterPhone) });
    if (claim.adjusterEmail !== null) rows.push({ label: claims.adjusterEmailLabel, value: claim.adjusterEmail, wide: true });

    body = (
      <>
        {rows.length > 0 ? (
          <dl className={styles.fields}>
            {rows.map((row) => (
              <div key={row.label} className={styles.fieldRow} data-wide={row.wide ? 'true' : undefined}>
                <dt className={styles.term}>{row.label}</dt>
                <dd className={styles.detail}>{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {claim.notes !== null ? <p className={styles.notes}>{claim.notes}</p> : null}
        {/* G1 Task 7 */}
        <div className={styles.actions}>
          <PacketActions jobId={jobId} packet={data.packet} dayFormat={dayFormat} />
        </div>
        {claim.events.length > 0 ? (
          <HistoryList>
            {claim.events.map((e) => (
              <li key={`${e.at}-${e.to}`}>
                {claims.historyLine(
                  claims.status[e.to],
                  e.by === 'agent' ? claims.claimsAgent : (e.byName ?? claims.unknownPerson),
                  dayFormat.format(new Date(e.at)),
                )}
              </li>
            ))}
          </HistoryList>
        ) : null}
      </>
    );
  }

  const status = claim === null ? null : STATUS_TAG[claim.status];
  return (
    <Panel
      title={claims.sectionTitle}
      className={className}
      data-section="claim"
      tag={
        claim !== null && status !== null ? (
          <Tag tone={status.tone} icon={status.icon}>
            {claims.status[claim.status]}
          </Tag>
        ) : undefined
      }
      actions={
        claim !== null ? (
          <Button variant="default" size="sm" onClick={() => setEditing(true)}>
            <Icon name="pen" size={16} />
            {claims.edit}
          </Button>
        ) : undefined
      }
    >
      <div className={styles.body}>{body}</div>
      {editing && data !== undefined ? <ClaimSheet jobId={jobId} data={data} onClose={() => setEditing(false)} /> : null}
    </Panel>
  );
}

/** The claim's history under its own small heading: each move of the status, who made it and the day. */
function HistoryList({ children }: { children: ReactNode }) {
  const headingId = useId();
  return (
    <div className={styles.history} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.subheading}>
        {claims.historyTitle}
      </h3>
      <ul className={styles.historyList}>{children}</ul>
    </div>
  );
}
