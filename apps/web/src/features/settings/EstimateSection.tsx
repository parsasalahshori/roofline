import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Banner, Button, EmptyState, Field, Skeleton, Toggle, useToast } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { estimateCopy } from '../../copy/financeEstimate.ts';
import { settings as settingsCopy } from '../../copy/settings.ts';
import { tiers } from '../../copy/tiers.ts';
import { formErrors } from '../auth/formErrors.ts';
import { useEstimatorSettings, useSaveEstimatorSettings, type EstimatorSettings } from './estimator-api.ts';
import styles from './FinanceEstimate.module.css';

/** The three number fields, by the key the API takes. The two switches have no field message of their own. */
type EstimateKey = 'defaultPitchX12' | 'overhangFt' | 'proposalValidDays';
const ESTIMATE_KEYS: readonly EstimateKey[] = ['defaultPitchX12', 'overhangFt', 'proposalValidDays'];

/** What the form shows. The numbers are text while they are typed. */
type Form = {
  pitch: string;
  overhang: string;
  days: string;
  changeClause: boolean;
  aerial: boolean;
};

function toForm(settings: EstimatorSettings): Form {
  return {
    pitch: String(settings.defaultPitchX12),
    overhang: String(settings.overhangFt),
    days: String(settings.proposalValidDays),
    changeClause: settings.estimateChangeClause,
    aerial: settings.aerialMeasure,
  };
}

/*
 * Each check returns the number when the text is allowed, or the words to show next to the field when it
 * is not. An empty field is always "required".
 */

function pitchOf(text: string): number | string {
  const trimmed = text.trim();
  if (trimmed === '') return estimateCopy.required;
  const pitch = Number(trimmed);
  if (!(Number.isFinite(pitch) && pitch >= 0 && pitch <= 24)) return estimateCopy.pitchRange;
  if (!Number.isInteger(pitch * 2)) return estimateCopy.pitchStep;
  return pitch;
}

function overhangOf(text: string): number | string {
  const trimmed = text.trim();
  if (trimmed === '') return estimateCopy.required;
  const overhang = Number(trimmed);
  if (!(Number.isFinite(overhang) && overhang >= 0 && overhang <= 3)) return estimateCopy.overhangRange;
  if (Math.abs(overhang * 10 - Math.round(overhang * 10)) > 1e-9) return estimateCopy.overhangStep;
  return overhang;
}

function daysOf(text: string): number | string {
  const trimmed = text.trim();
  if (trimmed === '') return estimateCopy.required;
  const days = Number(trimmed);
  if (!(Number.isInteger(days) && days >= 1 && days <= 180)) return estimateCopy.validDaysRange;
  return days;
}

/** The form checked before anything is sent: either the three numbers, or a message for each field that is wrong. */
type Checked =
  | {
      ok: true;
      values: {
        defaultPitchX12: number;
        overhangFt: number;
        proposalValidDays: number;
      };
    }
  | { ok: false; errors: Partial<Record<EstimateKey, string>> };

function check(form: Form): Checked {
  const pitch = pitchOf(form.pitch);
  const overhang = overhangOf(form.overhang);
  const days = daysOf(form.days);
  if (typeof pitch === 'number' && typeof overhang === 'number' && typeof days === 'number') {
    return {
      ok: true,
      values: {
        defaultPitchX12: pitch,
        overhangFt: overhang,
        proposalValidDays: days,
      },
    };
  }
  const errors: Partial<Record<EstimateKey, string>> = {};
  if (typeof pitch === 'string') errors.defaultPitchX12 = pitch;
  if (typeof overhang === 'string') errors.overhangFt = overhang;
  if (typeof days === 'string') errors.proposalValidDays = days;
  return { ok: false, errors };
}

/** A titled block of the Prices tab. Every state of the section sits inside it. */
function Section({ children }: { children: ReactNode }) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {estimateCopy.title}
      </h2>
      {children}
    </section>
  );
}

/** Estimate defaults and proposal terms: the owner sets them, everyone else reads them. */
export function EstimateSection() {
  const me = useMe();
  const estimator = useEstimatorSettings();

  // Shown only while there is nothing to show instead: a failed read with no earlier answer to keep
  const failure = estimator.error ?? me.error;
  if (estimator.data === undefined || me.data === undefined) {
    if (failure) {
      return (
        <Section>
          <EmptyState
            title={tiers.loadFailed}
            action={
              <Button
                variant="primary"
                onClick={() => {
                  void estimator.refetch();
                  void me.refetch();
                }}
              >
                {tiers.retry}
              </Button>
            }
          />
        </Section>
      );
    }
    return (
      <Section>
        <div role="status">
          <Skeleton lines={3} />
          <span className="visually-hidden">{settingsCopy.loading}</span>
        </div>
      </Section>
    );
  }

  return (
    <Section>
      <EstimateForm settings={estimator.data} canEdit={me.data.role === 'owner'} />
    </Section>
  );
}

function EstimateForm({ settings, canEdit }: { settings: EstimatorSettings; canEdit: boolean }) {
  const [form, setForm] = useState(() => toForm(settings));
  // Problems in the form are shown once the owner has tried to save, then follow the edits as they are made
  const [submitted, setSubmitted] = useState(false);
  const save = useSaveEstimatorSettings();
  const toast = useToast();
  // A problem about a switch has no field to sit beside, so it is shown at the top of the form
  const problems = formErrors(save.error, ESTIMATE_KEYS);
  const current = check(form);
  const clientErrors: Partial<Record<EstimateKey, string>> = submitted && !current.ok ? current.errors : {};

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    setSubmitted(true);
    const checked = check(form);
    if (!checked.ok) return;
    // The aerial switch is sent only when a provider is set up; otherwise there is no switch to send
    const body = {
      ...checked.values,
      estimateChangeClause: form.changeClause,
      ...(settings.aerialConfigured ? { aerialMeasure: form.aerial } : {}),
    };
    save.mutate(body, {
      onSuccess: (answer) => {
        // The answer is what the server kept: show that, not what was typed
        setForm(toForm(answer));
        toast.show(tiers.saved, 'success');
      },
    });
  }

  return (
    <>
      {canEdit ? null : <p className={styles.note}>{tiers.officeReadOnly}</p>}
      <form className={styles.form} onSubmit={submit} noValidate>
        {problems.general ? <Banner tone="danger">{problems.general}</Banner> : null}
        <Field
          label={estimateCopy.defaultPitch}
          name="defaultPitchX12"
          type="number"
          inputMode="decimal"
          step="0.5"
          min="0"
          max="24"
          value={form.pitch}
          onChange={(event) => setForm((previous) => ({ ...previous, pitch: event.target.value }))}
          disabled={!canEdit}
          error={clientErrors.defaultPitchX12 ?? problems.forField('defaultPitchX12')}
        />
        <Field
          label={estimateCopy.overhang}
          name="overhangFt"
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          max="3"
          value={form.overhang}
          onChange={(event) =>
            setForm((previous) => ({
              ...previous,
              overhang: event.target.value,
            }))
          }
          disabled={!canEdit}
          error={clientErrors.overhangFt ?? problems.forField('overhangFt')}
        />
        <Field
          label={estimateCopy.validDays}
          name="proposalValidDays"
          type="number"
          inputMode="numeric"
          step="1"
          min="1"
          max="180"
          value={form.days}
          onChange={(event) => setForm((previous) => ({ ...previous, days: event.target.value }))}
          disabled={!canEdit}
          error={clientErrors.proposalValidDays ?? problems.forField('proposalValidDays')}
        />
        <div className={styles.switch}>
          <Toggle
            label={estimateCopy.changeClause}
            checked={form.changeClause}
            onChange={(next) => setForm((previous) => ({ ...previous, changeClause: next }))}
            disabled={!canEdit}
          />
          <p className={styles.help}>{estimateCopy.changeClauseHelp}</p>
        </div>
        {settings.aerialConfigured ? (
          <div className={styles.switch}>
            <Toggle
              label={estimateCopy.aerial}
              checked={form.aerial}
              onChange={(next) => setForm((previous) => ({ ...previous, aerial: next }))}
              disabled={!canEdit}
            />
            <p className={styles.help}>{estimateCopy.aerialHelp}</p>
          </div>
        ) : null}
        {canEdit ? (
          <Button type="submit" variant="primary" className={styles.save} busy={save.isPending}>
            {tiers.save}
          </Button>
        ) : null}
      </form>
    </>
  );
}
