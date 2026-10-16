import { useState, type FormEvent } from 'react';
import { Button, EmptyState, Field, Icon, Listbox, Panel, Skeleton, useToast, type ListboxOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import type { CompanyBody } from '../../api/types.ts';
import { errors } from '../../copy/errors.ts';
import { settings } from '../../copy/settings.ts';
import { formErrors } from '../auth/formErrors.ts';
import { useCompany, useCompanySettings, useUpdateCompany, useUpdateHourlyRate, type CompanyPatch } from './api.ts';
import styles from './CompanyTab.module.css';
import form from './form.module.css';
import { SaveBar } from './SaveBar.tsx';

/** The form's fields, and the key each one sends in the PATCH body. */
type FieldKey = 'name' | 'phone' | 'email' | 'website' | 'street' | 'city' | 'state' | 'zip' | 'timezone';

const API_KEY: Record<FieldKey, keyof CompanyPatch> = {
  name: 'name',
  phone: 'phone',
  email: 'email',
  website: 'website',
  street: 'addressStreet',
  city: 'addressCity',
  state: 'addressState',
  zip: 'addressZip',
  timezone: 'timezone',
};

const FIELD_KEYS: readonly FieldKey[] = ['name', 'phone', 'email', 'website', 'street', 'city', 'state', 'zip', 'timezone'];

const FIELD_API_KEYS = Object.values(API_KEY);

/** What the form shows for a company. A missing value is an empty field. */
function toForm(company: CompanyBody): Record<FieldKey, string> {
  return {
    name: company.name,
    phone: company.phone ?? '',
    email: company.email ?? '',
    website: company.website ?? '',
    street: company.addressStreet ?? '',
    city: company.addressCity ?? '',
    state: company.addressState ?? '',
    zip: company.addressZip ?? '',
    timezone: company.timezone,
  };
}

/** Company details: the owner edits them, everyone else reads them. */
export function CompanyTab() {
  const me = useMe();
  const company = useCompany();

  // Shown only while there is nothing to show instead: a failed read with no earlier answer to keep
  const failure = company.error ?? me.error;
  if (company.data === undefined || me.data === undefined) {
    if (failure) {
      return (
        <EmptyState
          title={failure instanceof ApiError ? failure.message : errors.generic}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void company.refetch();
                void me.refetch();
              }}
            >
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
          <span className="visually-hidden">{settings.loading}</span>
        </div>
      </Panel>
    );
  }

  return <CompanyForm company={company.data} canEdit={me.data.role === 'owner'} />;
}

function CompanyForm({ company, canEdit }: { company: CompanyBody; canEdit: boolean }) {
  const [values, setValues] = useState(() => toForm(company));
  // The values the form was last loaded or saved with. Only fields that differ from these are sent, so a
  // company refetched in the background does not make untouched fields look changed.
  const [baseline, setBaseline] = useState(() => toForm(company));
  const update = useUpdateCompany();
  const toast = useToast();
  const problems = formErrors(update.error, FIELD_API_KEYS);

  const changes: CompanyPatch = {};
  for (const key of FIELD_KEYS) {
    if (values[key] !== baseline[key]) changes[API_KEY[key]] = values[key];
  }
  const changed = Object.keys(changes).length > 0;

  // Only the zones on the list plus the company's own zone, which goes first when it is not on the list
  const timeZoneOptions: ListboxOption[] = settings.company.timeZones.map((zone) => ({ value: zone.value, label: zone.label }));
  if (!timeZoneOptions.some((zone) => zone.value === company.timezone)) {
    timeZoneOptions.unshift({ value: company.timezone, label: company.timezone });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !changed) return;
    update.mutate(changes, {
      onSuccess: (saved) => {
        // The server may have tidied the values (a phone number with +1, a state in capitals): show those
        const next = toForm(saved);
        setBaseline(next);
        setValues(next);
        toast.show(settings.company.saved, 'success');
      },
      onError: (error) => {
        // A message about a field on this form sits under it; anything else is a toast
        const general = formErrors(error, FIELD_API_KEYS).general;
        if (general) toast.show(general, 'error');
      },
    });
  }

  return (
    <>
      <form className={form.form} onSubmit={submit} noValidate>
        <Panel title={settings.company.panels.details}>
          {canEdit ? null : (
            <p className={form.note}>
              <Icon name="lock" size={16} />
              {settings.company.ownerOnly}
            </p>
          )}
          <div className={form.grid}>
            <Field
              label={settings.company.fields.name}
              name="name"
              value={values.name}
              onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
              readOnly={!canEdit}
              error={problems.forField(API_KEY.name)}
            />
            <Field
              label={settings.company.fields.phone}
              name="phone"
              type="tel"
              value={values.phone}
              onChange={(event) => setValues((current) => ({ ...current, phone: event.target.value }))}
              readOnly={!canEdit}
              error={problems.forField(API_KEY.phone)}
            />
            <Field
              label={settings.company.fields.email}
              name="email"
              type="email"
              value={values.email}
              onChange={(event) => setValues((current) => ({ ...current, email: event.target.value }))}
              readOnly={!canEdit}
              error={problems.forField(API_KEY.email)}
            />
            <Field
              label={settings.company.fields.website}
              name="website"
              type="text"
              inputMode="url"
              value={values.website}
              onChange={(event) => setValues((current) => ({ ...current, website: event.target.value }))}
              readOnly={!canEdit}
              error={problems.forField(API_KEY.website)}
            />
            <Field
              className={form.span}
              label={settings.company.fields.street}
              name="street"
              value={values.street}
              onChange={(event) => setValues((current) => ({ ...current, street: event.target.value }))}
              readOnly={!canEdit}
              error={problems.forField(API_KEY.street)}
            />
            <Field
              label={settings.company.fields.city}
              name="city"
              value={values.city}
              onChange={(event) => setValues((current) => ({ ...current, city: event.target.value }))}
              readOnly={!canEdit}
              error={problems.forField(API_KEY.city)}
            />
            <Field
              label={settings.company.fields.state}
              name="state"
              value={values.state}
              onChange={(event) => setValues((current) => ({ ...current, state: event.target.value }))}
              readOnly={!canEdit}
              error={problems.forField(API_KEY.state)}
            />
            <Field
              label={settings.company.fields.zip}
              name="zip"
              value={values.zip}
              onChange={(event) => setValues((current) => ({ ...current, zip: event.target.value }))}
              readOnly={!canEdit}
              error={problems.forField(API_KEY.zip)}
            />
            <Listbox
              label={settings.company.fields.timezone}
              value={values.timezone}
              onChange={(value) => setValues((current) => ({ ...current, timezone: value }))}
              disabled={!canEdit}
              options={timeZoneOptions}
              error={problems.forField(API_KEY.timezone)}
            />
          </div>
        </Panel>
        {canEdit ? (
          <SaveBar
            dirty={changed}
            saving={update.isPending}
            saveLabel={settings.company.save}
            onDiscard={() => {
              update.reset();
              setValues(baseline);
            }}
          />
        ) : null}
      </form>
      {canEdit ? <HourlyRateForm /> : null}
    </>
  );
}

/** Cents as the field shows them: whole dollars without decimals, else two places. */
function toDollars(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** The typed dollars as cents, or null when they are not an amount from $0 to $1,000. */
function toCents(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = Math.round(Number(clean) * 100);
  return cents > 100000 ? null : cents;
}

/** The owner's hourly rate for time saved. It has its own endpoint, so it has its own form. */
function HourlyRateForm() {
  const rate = useCompanySettings(true);
  const update = useUpdateHourlyRate();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);

  if (rate.data === undefined) {
    if (rate.error) return <p className={styles.problem} role="alert">{settings.company.hourlyRate.loadError}</p>;
    return <Skeleton lines={1} />;
  }

  const saved = toDollars(rate.data.hourlyRateCents);
  const text = draft ?? saved;
  const cents = toCents(text);
  const invalid = cents === null;
  const unchanged = cents === rate.data.hourlyRateCents;
  const serverMessage = update.error instanceof ApiError ? update.error.message : update.error ? settings.company.hourlyRate.error : undefined;
  const error = invalid ? settings.company.hourlyRate.error : serverMessage;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cents === null || unchanged) return;
    update.mutate(cents, {
      onSuccess: () => {
        setDraft(null);
        toast.show(settings.company.hourlyRate.saved, 'success');
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <Panel
        title={settings.company.panels.rate}
        actions={
          <Button type="submit" variant="primary" size="sm" busy={update.isPending} disabled={invalid || unchanged}>
            {settings.company.hourlyRate.save}
          </Button>
        }
      >
        <div className={form.grid}>
          <Field
            label={settings.company.hourlyRate.label}
            name="hourlyRate"
            type="text"
            inputMode="decimal"
            value={text}
            onChange={(event) => {
              update.reset();
              setDraft(event.target.value);
            }}
            help={settings.company.hourlyRate.hint}
            error={error}
          />
        </div>
      </Panel>
    </form>
  );
}
