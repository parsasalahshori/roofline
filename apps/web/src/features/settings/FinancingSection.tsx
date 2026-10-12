import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Banner, Button, EmptyState, Field, Skeleton, useToast } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { financeCopy } from '../../copy/financeEstimate.ts';
import { settings as settingsCopy } from '../../copy/settings.ts';
import { tiers } from '../../copy/tiers.ts';
import { formErrors } from '../auth/formErrors.ts';
import { useEstimatorSettings, useSaveEstimatorSettings, type EstimatorSettings } from './estimator-api.ts';
import styles from './FinanceEstimate.module.css';

/** The two fields this section sends, by the key the API takes. */
type FinanceKey = 'financingAprBps' | 'financingTermMonths';
const FINANCE_KEYS: readonly FinanceKey[] = ['financingAprBps', 'financingTermMonths'];

/** What the form shows. Both are text, so an empty field is an empty string. */
type Form = { apr: string; term: string };

/** Basis points to percent text: 999 is "9.99". Null is an empty field. */
function toForm(settings: EstimatorSettings): Form {
  return {
    apr: settings.financingAprBps === null ? '' : String(settings.financingAprBps / 100),
    term: settings.financingTermMonths === null ? '' : String(settings.financingTermMonths),
  };
}

type Parsed = {
  values: {
    financingAprBps: number | null;
    financingTermMonths: number | null;
  };
  errors: Partial<Record<FinanceKey, string>>;
};

/**
 * Checks the form before anything is sent. Both empty means "no financing" (both null). One filled
 * is an error on the empty one. APR is 0 to 100 percent, sent as basis points; the term is a whole
 * number of months from 1 to 600.
 */
function parse(form: Form): Parsed {
  const aprText = form.apr.trim();
  const termText = form.term.trim();
  if (aprText === '' && termText === '') {
    return {
      values: { financingAprBps: null, financingTermMonths: null },
      errors: {},
    };
  }

  const errors: Partial<Record<FinanceKey, string>> = {};
  let financingAprBps: number | null = null;
  let financingTermMonths: number | null = null;

  if (aprText === '') {
    errors.financingAprBps = financeCopy.pairRequired;
  } else {
    const percent = Number(aprText);
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      financingAprBps = Math.round(percent * 100);
    } else {
      errors.financingAprBps = financeCopy.aprRange;
    }
  }

  if (termText === '') {
    errors.financingTermMonths = financeCopy.pairRequired;
  } else {
    const months = Number(termText);
    if (Number.isInteger(months) && months >= 1 && months <= 600) {
      financingTermMonths = months;
    } else {
      errors.financingTermMonths = financeCopy.termRange;
    }
  }

  return { values: { financingAprBps, financingTermMonths }, errors };
}

/** A titled block of the Prices tab. Every state of the section sits inside it. */
function Section({ children }: { children: ReactNode }) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {financeCopy.title}
      </h2>
      {children}
    </section>
  );
}

/** Financing for proposals: the owner sets the APR and term, everyone else reads them. */
export function FinancingSection() {
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
          <Skeleton lines={2} />
          <span className="visually-hidden">{settingsCopy.loading}</span>
        </div>
      </Section>
    );
  }

  return (
    <Section>
      <FinancingForm settings={estimator.data} canEdit={me.data.role === 'owner'} />
    </Section>
  );
}

function FinancingForm({ settings, canEdit }: { settings: EstimatorSettings; canEdit: boolean }) {
  const [form, setForm] = useState(() => toForm(settings));
  // Problems in the form are shown once the owner has tried to save, then follow the edits as they are made
  const [submitted, setSubmitted] = useState(false);
  const save = useSaveEstimatorSettings();
  const toast = useToast();
  const problems = formErrors(save.error, FINANCE_KEYS);
  const clientErrors: Partial<Record<FinanceKey, string>> = submitted ? parse(form).errors : {};
  const bothEmpty = form.apr.trim() === '' && form.term.trim() === '';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    setSubmitted(true);
    const parsed = parse(form);
    if (Object.keys(parsed.errors).length > 0) return;
    save.mutate(parsed.values, {
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
      <p className={styles.help}>{financeCopy.help}</p>
      {bothEmpty ? <p className={styles.help}>{financeCopy.notSet}</p> : null}
      <form className={styles.form} onSubmit={submit} noValidate>
        {problems.general ? <Banner tone="danger">{problems.general}</Banner> : null}
        <Field
          label={financeCopy.aprLabel}
          name="financingAprBps"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          max="100"
          value={form.apr}
          onChange={(event) => setForm((current) => ({ ...current, apr: event.target.value }))}
          disabled={!canEdit}
          error={clientErrors.financingAprBps ?? problems.forField('financingAprBps')}
        />
        <Field
          label={financeCopy.termLabel}
          name="financingTermMonths"
          type="number"
          inputMode="numeric"
          step="1"
          min="1"
          max="600"
          value={form.term}
          onChange={(event) => setForm((current) => ({ ...current, term: event.target.value }))}
          disabled={!canEdit}
          error={clientErrors.financingTermMonths ?? problems.forField('financingTermMonths')}
        />
        {canEdit ? (
          <Button type="submit" variant="primary" className={styles.save} busy={save.isPending}>
            {tiers.save}
          </Button>
        ) : null}
      </form>
    </>
  );
}
