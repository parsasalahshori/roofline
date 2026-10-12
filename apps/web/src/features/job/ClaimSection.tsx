import { useId, useMemo, useState } from 'react';
import { CLAIM_STATUSES, displayUsPhone, isTimeZone, type ClaimStatus, type JobClaimResponse } from '@roofline/shared';
import { Banner, Button, Field, Select, Sheet, Skeleton, useToast, type SelectOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { claims } from '../../copy/claims.ts';
import { claimPacketUrl, useBuildClaimPacket, useJobClaim, useSaveClaim, type ClaimEdit } from '../claims/api.ts';
import { formatDollars } from '../jobs/JobCardView.tsx';
import { useCompany } from '../settings/api.ts';
import styles from './ClaimSection.module.css';

const FALLBACK_ZONE = 'America/Chicago';

const statusOptions: SelectOption[] = CLAIM_STATUSES.map((s) => ({ value: s, label: claims.status[s] }));

/** The company's zone when it is one Intl knows, the Chicago default otherwise. Never the browser's. */
function useCompanyZone(): string {
  const company = useCompany();
  const zone = company.data?.timezone;
  return zone !== undefined && isTimeZone(zone) ? zone : FALLBACK_ZONE;
}

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
      <Button variant="ghost" onClick={onClose}>
        {claims.cancel}
      </Button>
      <Button busy={save.isPending} onClick={() => void submit()}>
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
      <div className={styles.body}>
        {textField('insurer', claims.insurerLabel)}
        {textField('claimNumber', claims.claimNumberLabel)}
        {textField('dateOfLoss', claims.dateOfLossLabel, { type: 'date' })}
        <Select
          label={claims.statusLabel}
          value={values.status}
          options={statusOptions}
          error={errors.status}
          onChange={(next) => setValue('status', next as ClaimStatus)}
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
      <Button variant="ghost" busy={build.isPending} onClick={run}>
        {build.isPending ? claims.buildingPacket : claims.buildPacket}
      </Button>
      {packet !== null ? (
        <a className={styles.link} href={claimPacketUrl(jobId)} target="_blank" rel="noreferrer">
          {claims.downloadPacket(dayFormat.format(new Date(packet.builtAt)))}
        </a>
      ) : null}
    </>
  );
}

/** The job's insurance claim: its status, details and history, with a form to add or edit them. */
export function ClaimSection({ jobId }: { jobId: string }) {
  const headingId = useId();
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

  function content() {
    if (query.isPending) {
      return (
        <div role="status" aria-label={claims.loading}>
          <Skeleton lines={3} />
        </div>
      );
    }
    if (query.isError) return <Banner tone="danger">{claims.loadError}</Banner>;
    const { claim, intake } = query.data;
    const sheet = editing ? <ClaimSheet jobId={jobId} data={query.data} onClose={() => setEditing(false)} /> : null;

    if (claim === null) {
      return (
        <>
          <p className={styles.text}>{intake === null ? claims.none : claims.intakeLine(intake.insurer, intake.claimNumber)}</p>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setEditing(true)}>
              {claims.addDetails}
            </Button>
          </div>
          {sheet}
        </>
      );
    }

    const rows: { label: string; value: string }[] = [];
    if (claim.insurer !== null) rows.push({ label: claims.insurerLabel, value: claim.insurer });
    if (claim.claimNumber !== null) rows.push({ label: claims.claimNumberLabel, value: claim.claimNumber });
    if (claim.dateOfLoss !== null) rows.push({ label: claims.dateOfLossLabel, value: dateOfLossText(claim.dateOfLoss) });
    if (claim.adjusterName !== null) rows.push({ label: claims.adjusterNameLabel, value: claim.adjusterName });
    if (claim.adjusterPhone !== null) rows.push({ label: claims.adjusterPhoneLabel, value: displayUsPhone(claim.adjusterPhone) });
    if (claim.adjusterEmail !== null) rows.push({ label: claims.adjusterEmailLabel, value: claim.adjusterEmail });
    if (claim.deductibleCents !== null) rows.push({ label: claims.deductibleLabel, value: formatDollars(claim.deductibleCents) });

    return (
      <>
        <span className={styles.chip}>{claims.status[claim.status]}</span>
        {rows.length > 0 ? (
          <dl className={styles.fields}>
            {rows.map((row) => (
              <div key={row.label} className={styles.fieldRow}>
                <dt className={styles.term}>{row.label}</dt>
                <dd className={styles.detail}>{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {claim.notes !== null ? <p className={styles.detail}>{claim.notes}</p> : null}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => setEditing(true)}>
            {claims.edit}
          </Button>
          {/* G1 Task 7 */}
          <PacketActions jobId={jobId} packet={query.data.packet} dayFormat={dayFormat} />
        </div>
        {claim.events.length > 0 ? (
          <>
            <h3 className={styles.subheading}>{claims.historyTitle}</h3>
            <ul className={styles.history}>
              {claim.events.map((e) => (
                <li key={`${e.at}-${e.to}`}>
                  {claims.historyLine(
                    claims.status[e.to],
                    e.by === 'agent' ? claims.claimsAgent : (e.byName ?? claims.unknownPerson),
                    dayFormat.format(new Date(e.at)),
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {sheet}
      </>
    );
  }

  return (
    <section aria-labelledby={headingId} className={styles.section} data-section="claim">
      <h2 id={headingId} className={styles.heading}>
        {claims.sectionTitle}
      </h2>
      {content()}
    </section>
  );
}
