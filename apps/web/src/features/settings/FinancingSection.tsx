import { useState, type FormEvent, type ReactNode } from 'react';
import { Banner, Button, EmptyState, Field, Icon, Panel, Skeleton, useToast } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { financeCopy } from '../../copy/financeEstimate.ts';
import { settings as settingsCopy } from '../../copy/settings.ts';
import { tiers } from '../../copy/tiers.ts';
import { formErrors } from '../auth/formErrors.ts';
import type { EstimatorSettings } from '@roofline/shared';
import { useEstimatorSettings, useSaveEstimatorSettings } from './estimator-api.ts';
import styles from './FinanceEstimate.module.css';
import form from './form.module.css';
import { SaveBar } from './SaveBar.tsx';

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
 * is an error on the empty one. APR is 0 to 50 percent, sent as basis points; the term is a whole
 * number of months from 1 to 360.
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
    if (Number.isFinite(percent) && percent >= 0 && percent <= 50) {
      financingAprBps = Math.round(percent * 100);
    } else {
      errors.financingAprBps = financeCopy.aprRange;
    }
  }

  if (termText === '') {
    errors.financingTermMonths = financeCopy.pairRequired;
  } else {
    const months = Number(termText);
    if (Number.isInteger(months) && months >= 1 && months <= 360) {
      financingTermMonths = months;
    } else {
      errors.financingTermMonths = financeCopy.termRange;
    }
  }

  return { values: { financingAprBps, financingTermMonths }, errors };
}

/** The panel of the Prices tab the loading line and the failure sit in. The form brings its own panel. */
function Section({ children }: { children: ReactNode }) {
  return <Panel title={financeCopy.title}>{children}</Panel>;
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

  return <FinancingForm settings={estimator.data} canEdit={me.data.role === 'owner'} />;
}

function FinancingForm({ settings, canEdit }: { settings: EstimatorSettings; canEdit: boolean }) {
  const [values, setValues] = useState(() => toForm(settings));
  // What the form was last loaded or saved as: only a difference makes it saveable
  const [baseline, setBaseline] = useState(() => toForm(settings));
  // Problems in the form are shown once the owner has tried to save, then follow the edits as they are made
  const [submitted, setSubmitted] = useState(false);
  const save = useSaveEstimatorSettings();
  const toast = useToast();
  const problems = formErrors(save.error, FINANCE_KEYS);
  const clientErrors: Partial<Record<FinanceKey, string>> = submitted ? parse(values).errors : {};
  const bothEmpty = values.apr.trim() === '' && values.term.trim() === '';
  const changed = values.apr !== baseline.apr || values.term !== baseline.term;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    setSubmitted(true);
    const parsed = parse(values);
    if (Object.keys(parsed.errors).length > 0) return;
    save.mutate(parsed.values, {
      onSuccess: (answer) => {
        // The answer is what the server kept: show that, not what was typed
        const next = toForm(answer);
        setValues(next);
        setBaseline(next);
        setSubmitted(false);
        toast.show(tiers.saved, 'success');
      },
    });
  }

  return (
    <form className={form.form} onSubmit={submit} noValidate>
      <Panel title={financeCopy.title}>
        {canEdit ? null : (
          <p className={form.note}>
            <Icon name="lock" size={16} />
            {tiers.officeReadOnly}
          </p>
        )}
        {problems.general ? (
          <div className={styles.banner}>
            <Banner tone="danger">{problems.general}</Banner>
          </div>
        ) : null}
        <p className={styles.lead}>{financeCopy.help}</p>
        {bothEmpty ? <p className={styles.lead}>{financeCopy.notSet}</p> : null}
        <div className={form.grid}>
          <Field
            label={financeCopy.aprLabel}
            name="financingAprBps"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            max="50"
            value={values.apr}
            onChange={(event) => setValues((current) => ({ ...current, apr: event.target.value }))}
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
            max="360"
            value={values.term}
            onChange={(event) => setValues((current) => ({ ...current, term: event.target.value }))}
            disabled={!canEdit}
            error={clientErrors.financingTermMonths ?? problems.forField('financingTermMonths')}
          />
        </div>
      </Panel>
      {canEdit ? (
        <SaveBar
          dirty={changed}
          saving={save.isPending}
          saveLabel={tiers.save}
          onDiscard={() => {
            save.reset();
            setValues(baseline);
            setSubmitted(false);
          }}
        />
      ) : null}
    </form>
  );
}
