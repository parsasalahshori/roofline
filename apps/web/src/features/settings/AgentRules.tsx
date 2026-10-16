import { useId, useState, type FormEvent } from 'react';
import { Button, Checkbox, EmptyState, Field, Panel, Skeleton, useToast } from '@roofline/ui';
import type { AgentValues } from '@roofline/shared';
import { ApiError } from '../../api/client.ts';
import { errors } from '../../copy/errors.ts';
import { agentRules } from '../../copy/agents.ts';
import { useAgentValues, useUpdateAgentValues, type AgentValuesPatchBody } from './api.ts';
import layout from './form.module.css';
import { SaveBar } from './SaveBar.tsx';
import styles from './AgentRules.module.css';

/** The form's text values. Numbers stay as typed until they are sent, so a half-typed number is not lost. */
type FormState = {
  nudge: string[];
  rain: string;
  gust: string;
  hour: string;
  reviews: boolean;
  leads: boolean;
  proposals: boolean;
  followup: string[];
  leadDays: string;
  reviewLink: string;
  reviewDelay: string;
};

/** The API field names this form shows. A message about any other field goes in a toast. */
const FORM_FIELDS: readonly string[] = [
  'claimsNudgeDays',
  'weatherRainPct',
  'weatherGustMph',
  'reminderHour',
  'followupDays',
  'leadFollowupDays',
  'reviewLink',
  'reviewDelayDays',
  'followupReviews',
  'followupLeads',
  'followupProposals',
];

/** The field a failed save names, with any index on it removed (`claimsNudgeDays.1` is `claimsNudgeDays`). */
function errorField(error: Error | null): string | undefined {
  if (!(error instanceof ApiError) || error.field === undefined) return undefined;
  const base = error.field.split(/[.[\]]/)[0] ?? '';
  return FORM_FIELDS.includes(base) ? base : undefined;
}

function toForm(values: AgentValues): FormState {
  return {
    nudge: values.claimsNudgeDays.map(String),
    rain: String(values.weatherRainPct),
    gust: String(values.weatherGustMph),
    hour: String(values.reminderHour),
    reviews: values.followupReviews,
    leads: values.followupLeads,
    proposals: values.followupProposals,
    followup: values.followupDays.map(String),
    leadDays: String(values.leadFollowupDays),
    reviewLink: values.reviewLink ?? '',
    reviewDelay: String(values.reviewDelayDays),
  };
}

/**
 * The fields that differ from the baseline, as the PATCH body. A number that is not a whole number
 * is not sent; its problem is returned under its field name instead.
 */
function changesFrom(form: FormState, baseline: FormState): { changes: AgentValuesPatchBody; problems: Record<string, string> } {
  const changes: AgentValuesPatchBody = {};
  const problems: Record<string, string> = {};

  const whole = (key: string, text: string): number | null => {
    const trimmed = text.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    problems[key] = agentRules.notWholeNumber;
    return null;
  };

  if (form.nudge.join() !== baseline.nudge.join()) {
    const days = form.nudge.map((text) => whole('claimsNudgeDays', text));
    if (days.every((day): day is number => day !== null)) changes.claimsNudgeDays = days as [number, number, number];
  }
  if (form.rain !== baseline.rain) {
    const value = whole('weatherRainPct', form.rain);
    if (value !== null) changes.weatherRainPct = value;
  }
  if (form.gust !== baseline.gust) {
    const value = whole('weatherGustMph', form.gust);
    if (value !== null) changes.weatherGustMph = value;
  }
  if (form.hour !== baseline.hour) {
    const value = whole('reminderHour', form.hour);
    if (value !== null) changes.reminderHour = value;
  }
  if (form.reviews !== baseline.reviews) changes.followupReviews = form.reviews;
  if (form.leads !== baseline.leads) changes.followupLeads = form.leads;
  if (form.proposals !== baseline.proposals) changes.followupProposals = form.proposals;
  if (form.followup.join() !== baseline.followup.join()) {
    const days = form.followup.map((text) => whole('followupDays', text));
    if (days.every((day): day is number => day !== null)) changes.followupDays = days as [number, number];
  }
  if (form.leadDays !== baseline.leadDays) {
    const value = whole('leadFollowupDays', form.leadDays);
    if (value !== null) changes.leadFollowupDays = value;
  }
  if (form.reviewLink !== baseline.reviewLink) changes.reviewLink = form.reviewLink.trim();
  if (form.reviewDelay !== baseline.reviewDelay) {
    const value = whole('reviewDelayDays', form.reviewDelay);
    if (value !== null) changes.reviewDelayDays = value;
  }

  return { changes, problems };
}

/** Agent rule values: the three groups of rules on Settings → Agents. */
export function AgentRules() {
  const values = useAgentValues();

  if (values.data === undefined) {
    if (values.error) {
      if (values.error instanceof ApiError && values.error.status === 403) {
        return <EmptyState title={agentRules.ownerOnly} />;
      }
      return (
        <EmptyState
          title={values.error instanceof ApiError ? values.error.message : errors.generic}
          action={
            <Button variant="primary" onClick={() => void values.refetch()}>
              {errors.tryAgain}
            </Button>
          }
        />
      );
    }
    return (
      <Panel>
        <div role="status">
          <Skeleton lines={4} />
          <span className="visually-hidden">{agentRules.loading}</span>
        </div>
      </Panel>
    );
  }

  return <AgentRulesForm values={values.data} />;
}

function AgentRulesForm({ values }: { values: AgentValues }) {
  const [form, setForm] = useState(() => toForm(values));
  // What the form was last loaded or saved with. Only fields that differ from it are sent.
  const [baseline, setBaseline] = useState(() => toForm(values));
  const [localProblems, setLocalProblems] = useState<Record<string, string>>({});
  const update = useUpdateAgentValues();
  const toast = useToast();
  const titleId = useId();

  const serverField = errorField(update.error);
  const problemFor = (field: string): string | undefined =>
    localProblems[field] ?? (serverField === field ? update.error?.message : undefined);

  // Save is open once anything differs, so a number that is not whole is answered under its field
  const hasChanges = JSON.stringify(form) !== JSON.stringify(baseline);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function setAt(key: 'nudge' | 'followup', index: number, value: string) {
    setForm((current) => {
      const next = [...current[key]];
      next[index] = value;
      return { ...current, [key]: next };
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { changes, problems } = changesFrom(form, baseline);
    setLocalProblems(problems);
    if (Object.keys(problems).length > 0 || Object.keys(changes).length === 0) return;
    update.mutate(changes, {
      onSuccess: (saved) => {
        // The server may have tidied the values: show those
        const next = toForm(saved);
        setBaseline(next);
        setForm(next);
        toast.show(agentRules.saved, 'success');
      },
      onError: (error) => {
        // A message about a field on this form sits under it; anything else is a toast
        if (errorField(error) === undefined) toast.show(error instanceof ApiError ? error.message : errors.generic, 'error');
      },
    });
  }

  return (
    <section className={layout.section} aria-labelledby={titleId}>
      <div className={layout.sectionHead}>
        <h2 id={titleId} className={layout.sectionTitle}>
          {agentRules.title}
        </h2>
      </div>
      <form className={layout.form} onSubmit={submit} noValidate>
        <Panel title={agentRules.groups.claims} headingLevel={3}>
          <div className={styles.body}>
            <p className={layout.help}>{agentRules.claimsHelp}</p>
            <div className={layout.grid}>
              {agentRules.nudgeDayLabels.map((label, index) => (
                <Field
                  key={label}
                  name={`claimsNudgeDays${index}`}
                  label={label}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={60}
                  value={form.nudge[index] ?? ''}
                  onChange={(event) => setAt('nudge', index, event.target.value)}
                />
              ))}
            </div>
            {problemFor('claimsNudgeDays') ? (
              <p role="alert" className={styles.problem}>
                {problemFor('claimsNudgeDays')}
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel title={agentRules.groups.scheduler} headingLevel={3}>
          <div className={layout.grid}>
            <Field
              name="reminderHour"
              label={agentRules.hourLabel}
              help={agentRules.hourHelp}
              type="number"
              inputMode="numeric"
              min={0}
              max={23}
              value={form.hour}
              error={problemFor('reminderHour')}
              onChange={(event) => set('hour', event.target.value)}
            />
            <Field
              name="weatherRainPct"
              label={agentRules.rainLabel}
              help={agentRules.rainHelp}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={form.rain}
              error={problemFor('weatherRainPct')}
              onChange={(event) => set('rain', event.target.value)}
            />
            <Field
              name="weatherGustMph"
              label={agentRules.gustLabel}
              help={agentRules.gustHelp}
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={form.gust}
              error={problemFor('weatherGustMph')}
              onChange={(event) => set('gust', event.target.value)}
            />
          </div>
        </Panel>

        <Panel title={agentRules.groups.followup} headingLevel={3}>
          <div className={styles.body}>
            <div className={styles.switches}>
              <Checkbox
                checked={form.reviews}
                onChange={(next) => set('reviews', next)}
                label={agentRules.reviewsLabel}
                description={agentRules.reviewsHelp}
                error={problemFor('followupReviews')}
              />
              <Checkbox
                checked={form.leads}
                onChange={(next) => set('leads', next)}
                label={agentRules.leadsLabel}
                description={agentRules.leadsHelp}
                error={problemFor('followupLeads')}
              />
              <Checkbox
                checked={form.proposals}
                onChange={(next) => set('proposals', next)}
                label={agentRules.proposalsLabel}
                description={agentRules.proposalsHelp}
                error={problemFor('followupProposals')}
              />
            </div>
            <p className={`${layout.help} ${styles.rule}`}>{agentRules.followupDaysHelp}</p>
            <div className={layout.grid}>
              {agentRules.followupDayLabels.map((label, index) => (
                <Field
                  key={label}
                  name={`followupDays${index}`}
                  label={label}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={30}
                  value={form.followup[index] ?? ''}
                  onChange={(event) => setAt('followup', index, event.target.value)}
                />
              ))}
            </div>
            {problemFor('followupDays') ? (
              <p role="alert" className={styles.problem}>
                {problemFor('followupDays')}
              </p>
            ) : null}
            <div className={layout.grid}>
              <Field
                name="leadFollowupDays"
                label={agentRules.leadDaysLabel}
                help={agentRules.leadDaysHelp}
                type="number"
                inputMode="numeric"
                min={1}
                max={30}
                value={form.leadDays}
                error={problemFor('leadFollowupDays')}
                onChange={(event) => set('leadDays', event.target.value)}
              />
              <Field
                name="reviewDelayDays"
                label={agentRules.reviewDelayLabel}
                help={agentRules.reviewDelayHelp}
                type="number"
                inputMode="numeric"
                min={0}
                max={30}
                value={form.reviewDelay}
                error={problemFor('reviewDelayDays')}
                onChange={(event) => set('reviewDelay', event.target.value)}
              />
              <div className={layout.span}>
                <Field
                  name="reviewLink"
                  label={agentRules.reviewLinkLabel}
                  help={agentRules.reviewLinkHelp}
                  type="url"
                  value={form.reviewLink}
                  error={problemFor('reviewLink')}
                  onChange={(event) => set('reviewLink', event.target.value)}
                />
              </div>
            </div>
          </div>
        </Panel>

        <SaveBar
          dirty={hasChanges}
          saving={update.isPending}
          saveLabel={agentRules.save}
          onDiscard={() => {
            setForm(baseline);
            setLocalProblems({});
            update.reset();
          }}
        />
        {update.isPending ? <span className="visually-hidden">{agentRules.saving}</span> : null}
      </form>
    </section>
  );
}
