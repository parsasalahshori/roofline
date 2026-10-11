import { useState, type FormEvent } from 'react';
import { Button, EmptyState, Field, Select, Skeleton, useToast, type SelectOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import type { CompanyBody } from '../../api/types.ts';
import { errors } from '../../copy/errors.ts';
import { settings } from '../../copy/settings.ts';
import { formErrors } from '../auth/formErrors.ts';
import { useCompany, useUpdateCompany, type CompanyPatch } from './api.ts';
import styles from './CompanyTab.module.css';

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
      <div role="status">
        <Skeleton lines={4} />
        <span className="visually-hidden">{settings.loading}</span>
      </div>
    );
  }

  return <CompanyForm company={company.data} canEdit={me.data.role === 'owner'} />;
}

function CompanyForm({ company, canEdit }: { company: CompanyBody; canEdit: boolean }) {
  const [form, setForm] = useState(() => toForm(company));
  // The values the form was last loaded or saved with. Only fields that differ from these are sent, so a
  // company refetched in the background does not make untouched fields look changed.
  const [baseline, setBaseline] = useState(() => toForm(company));
  const update = useUpdateCompany();
  const toast = useToast();
  const problems = formErrors(update.error, FIELD_API_KEYS);

  const changes: CompanyPatch = {};
  for (const key of FIELD_KEYS) {
    if (form[key] !== baseline[key]) changes[API_KEY[key]] = form[key];
  }
  const changed = Object.keys(changes).length > 0;

  // Only the zones on the list plus the company's own zone, which goes first when it is not on the list
  const timeZoneOptions: SelectOption[] = settings.company.timeZones.map((zone) => ({ value: zone.value, label: zone.label }));
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
        setForm(next);
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
      {canEdit ? null : <p className={styles.note}>{settings.company.ownerOnly}</p>}
      <form className={styles.form} onSubmit={submit} noValidate>
        <Field
          label={settings.company.fields.name}
          name="name"
          value={form.name}
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          readOnly={!canEdit}
          error={problems.forField(API_KEY.name)}
        />
        <Field
          label={settings.company.fields.phone}
          name="phone"
          type="tel"
          value={form.phone}
          onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
          readOnly={!canEdit}
          error={problems.forField(API_KEY.phone)}
        />
        <Field
          label={settings.company.fields.email}
          name="email"
          type="email"
          value={form.email}
          onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
          readOnly={!canEdit}
          error={problems.forField(API_KEY.email)}
        />
        <Field
          label={settings.company.fields.website}
          name="website"
          type="text"
          inputMode="url"
          value={form.website}
          onChange={(event) => setForm((current) => ({ ...current, website: event.target.value }))}
          readOnly={!canEdit}
          error={problems.forField(API_KEY.website)}
        />
        <Field
          label={settings.company.fields.street}
          name="street"
          value={form.street}
          onChange={(event) => setForm((current) => ({ ...current, street: event.target.value }))}
          readOnly={!canEdit}
          error={problems.forField(API_KEY.street)}
        />
        <Field
          label={settings.company.fields.city}
          name="city"
          value={form.city}
          onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))}
          readOnly={!canEdit}
          error={problems.forField(API_KEY.city)}
        />
        <Field
          label={settings.company.fields.state}
          name="state"
          value={form.state}
          onChange={(event) => setForm((current) => ({ ...current, state: event.target.value }))}
          readOnly={!canEdit}
          error={problems.forField(API_KEY.state)}
        />
        <Field
          label={settings.company.fields.zip}
          name="zip"
          value={form.zip}
          onChange={(event) => setForm((current) => ({ ...current, zip: event.target.value }))}
          readOnly={!canEdit}
          error={problems.forField(API_KEY.zip)}
        />
        <Select
          label={settings.company.fields.timezone}
          value={form.timezone}
          onChange={(value) => setForm((current) => ({ ...current, timezone: value }))}
          disabled={!canEdit}
          options={timeZoneOptions}
          error={problems.forField(API_KEY.timezone)}
        />
        {canEdit ? (
          <Button
            className={styles.save}
            type="submit"
            variant="primary"
            busy={update.isPending}
            disabled={!changed}
          >
            {settings.company.save}
          </Button>
        ) : null}
      </form>
    </>
  );
}
