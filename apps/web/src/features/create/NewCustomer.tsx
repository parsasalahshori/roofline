import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Checkbox, Field, Icon, Panel, useToast } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { create } from '../../copy/create.ts';
import { errors } from '../../copy/errors.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { DetailPage } from '../jobs/DetailPage.tsx';
import { AddressFields, EMPTY_ADDRESS, type AddressValue } from './AddressFields.tsx';
import { FormActions } from './FormActions.tsx';
import { useMe } from '../../api/hooks.ts';
import { useCreateCustomer, useCreateProperty, type CustomerInput, type CustomerRecord } from './api.ts';
import styles from './NewCustomer.module.css';

/** Phone and email inputs a person can add, up to this many of each. */
const MAX_ROWS = 10;

/** One phone or email input. The id keeps each input and its message apart from the others when rows change. */
type Row = { id: number; value: string };

/**
 * Messages keyed by the field they sit under: `displayName`, `firstName`, `lastName`, `phone:<row id>`,
 * `email:<row id>`, or one of the address fields.
 */
type FieldErrors = Record<string, string>;

const ADDRESS_KEYS: readonly string[] = ['addressLine', 'city', 'state', 'zip'];

let lastRowId = 0;

/** A new empty phone or email row. */
function makeRow(): Row {
  lastRowId += 1;
  return { id: lastRowId, value: '' };
}

/** The rows with one more appended, unless the list is already full. */
function addRow(rows: Row[]): Row[] {
  return rows.length < MAX_ROWS ? [...rows, makeRow()] : rows;
}

/** The display name the form proposes: first and last name, each trimmed, joined by one space. */
function joinName(first: string, last: string): string {
  return [first, last]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

/** The error key for a server field name about the customer, given the rows that were sent. */
function customerFieldKey(field: string, phoneRows: Row[], emailRows: Row[]): string | undefined {
  if (field === 'displayName' || field === 'firstName' || field === 'lastName') return field;
  const phone = /^phones\.(\d+)(?:\.number)?$/.exec(field);
  if (phone) {
    const row = phoneRows[Number(phone[1])];
    return row === undefined ? undefined : `phone:${row.id}`;
  }
  const email = /^emails(?:\.(\d+))?$/.exec(field);
  if (email) {
    const row = emailRows[Number(email[1] ?? 0)];
    return row === undefined ? undefined : `email:${row.id}`;
  }
  return undefined;
}

/** The New customer screen: a customer, then, if an address was entered, their first home. */
export function NewCustomer() {
  const navigate = useNavigate();
  const toast = useToast();
  const createCustomer = useCreateCustomer();
  const createProperty = useCreateProperty();
  const me = useMe();
  // The server accepts consent only from owner and office (requireConsentRole); false while the account loads
  const canConsent = me.data?.role === 'owner' || me.data?.role === 'office';

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [displayName, setDisplayName] = useState('');
  // Once the person types in the display name, it stops following the first and last name
  const [displayEdited, setDisplayEdited] = useState(false);
  const [phones, setPhones] = useState<Row[]>(() => [makeRow()]);
  const [emails, setEmails] = useState<Row[]>(() => [makeRow()]);
  const [home, setHome] = useState<AddressValue>(EMPTY_ADDRESS);
  const [textConsent, setTextConsent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // The customer once it is saved. A later Save retries only the home, so the customer is never created twice.
  const [saved, setSaved] = useState<CustomerRecord | null>(null);

  const pending = createCustomer.isPending || createProperty.isPending;
  const locked = saved !== null;

  function changeName(part: 'first' | 'last', value: string) {
    const nextFirst = part === 'first' ? value : firstName;
    const nextLast = part === 'last' ? value : lastName;
    if (part === 'first') setFirstName(value);
    else setLastName(value);
    if (!displayEdited) setDisplayName(joinName(nextFirst, nextLast));
  }

  /** Shows a server message under its field, or as a toast when it names no field on this form. */
  function fail(error: unknown, keyFor: (field: string) => string | undefined) {
    const message = error instanceof ApiError ? error.message : errors.generic;
    const key = error instanceof ApiError && error.field !== undefined ? keyFor(error.field) : undefined;
    if (key === undefined) {
      toast.show(message, 'error');
      return;
    }
    setFieldErrors({ [key]: message });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFieldErrors({});

    let customer = saved;
    if (customer === null) {
      const phoneRows = phones.filter((row) => row.value.trim() !== '');
      const emailRows = emails.filter((row) => row.value.trim() !== '');
      const first = firstName.trim();
      const last = lastName.trim();
      const body: CustomerInput = {
        displayName: displayName.trim(),
        ...(first === '' ? {} : { firstName: first }),
        ...(last === '' ? {} : { lastName: last }),
        ...(phoneRows.length === 0 ? {} : { phones: phoneRows.map((row, index) => ({ number: row.value.trim(), primary: index === 0 })) }),
        ...(emailRows.length === 0 ? {} : { emails: emailRows.map((row) => row.value.trim()) }),
        ...(canConsent && textConsent ? { smsConsentStatus: 'express' as const } : {}),
      };
      try {
        customer = await createCustomer.mutateAsync(body);
      } catch (error) {
        fail(error, (field) => customerFieldKey(field, phoneRows, emailRows));
        return;
      }
      setSaved(customer);
    }

    if ([home.addressLine, home.city, home.state, home.zip].some((part) => part.trim() !== '')) {
      try {
        const property = await createProperty.mutateAsync({
          customerId: customer.id,
          addressLine: home.addressLine.trim(),
          city: home.city.trim(),
          state: home.state.trim(),
          zip: home.zip.trim(),
        });
        if (property.lat === null || property.lng === null) toast.show(create.notOnMap, 'info');
      } catch (error) {
        fail(error, (field) => (ADDRESS_KEYS.includes(field) ? field : undefined));
        return;
      }
    }

    void navigate(`/customers/${customer.id}`);
  }

  const homeErrors = {
    addressLine: fieldErrors.addressLine,
    city: fieldErrors.city,
    state: fieldErrors.state,
    zip: fieldErrors.zip,
  };

  return (
    <DetailPage
      app="customers"
      title={create.newCustomer.title}
      crumbs={[{ label: WINDOW_COPY.customers.title, href: '/customers' }, { label: create.newCustomer.title }]}
      subtitle={create.newCustomer.subtitle}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <Panel title={create.newCustomer.stepName}>
          <div className={styles.names}>
            <Field
              label={create.newCustomer.firstName}
              name="firstName"
              autoComplete="given-name"
              value={firstName}
              readOnly={locked}
              onChange={(event) => changeName('first', event.target.value)}
              error={fieldErrors.firstName}
            />
            <Field
              label={create.newCustomer.lastName}
              name="lastName"
              autoComplete="family-name"
              value={lastName}
              readOnly={locked}
              onChange={(event) => changeName('last', event.target.value)}
              error={fieldErrors.lastName}
            />
            <Field
              className={styles.wide}
              label={create.newCustomer.displayName}
              help={create.newCustomer.displayNameHelp}
              name="displayName"
              value={displayName}
              readOnly={locked}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setDisplayEdited(true);
              }}
              error={fieldErrors.displayName}
            />
          </div>
        </Panel>

        <Panel title={create.newCustomer.stepContact}>
          <div className={styles.contacts}>
            <div className={styles.column}>
              {phones.map((row, index) => (
                <Field
                  key={row.id}
                  className={styles.input}
                  label={index === 0 ? create.newCustomer.phone : create.newCustomer.anotherPhone}
                  name="phone"
                  type="tel"
                  value={row.value}
                  readOnly={locked}
                  onChange={(event) => {
                    const value = event.target.value;
                    setPhones((rows) => rows.map((item) => (item.id === row.id ? { ...item, value } : item)));
                  }}
                  error={fieldErrors[`phone:${row.id}`]}
                />
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                flush="start"
                className={styles.addRow}
                disabled={locked || phones.length >= MAX_ROWS}
                onClick={() => setPhones(addRow)}
              >
                <Icon name="plus" size={16} />
                {create.newCustomer.addPhone}
              </Button>
            </div>

            <div className={styles.column}>
              {emails.map((row, index) => (
                <Field
                  key={row.id}
                  className={styles.input}
                  label={index === 0 ? create.newCustomer.email : create.newCustomer.anotherEmail}
                  name="email"
                  type="email"
                  value={row.value}
                  readOnly={locked}
                  onChange={(event) => {
                    const value = event.target.value;
                    setEmails((rows) => rows.map((item) => (item.id === row.id ? { ...item, value } : item)));
                  }}
                  error={fieldErrors[`email:${row.id}`]}
                />
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                flush="start"
                className={styles.addRow}
                disabled={locked || emails.length >= MAX_ROWS}
                onClick={() => setEmails(addRow)}
              >
                <Icon name="plus" size={16} />
                {create.newCustomer.addEmail}
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title={create.newCustomer.firstHome}>
          <AddressFields value={home} onChange={setHome} errors={homeErrors} />
        </Panel>

        {canConsent && (
          <Checkbox checked={textConsent} onChange={setTextConsent} label={create.newCustomer.textConsent} disabled={locked} />
        )}

        <FormActions
          className={styles.actions}
          save={
            <Button type="submit" variant="primary" className={styles.save} busy={pending}>
              {pending ? create.saving : create.newCustomer.save}
            </Button>
          }
          cancel={
            <Button href="/customers" variant="ghost">
              {create.newCustomer.cancel}
            </Button>
          }
        />
      </form>
    </DetailPage>
  );
}
