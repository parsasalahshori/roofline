import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { JOB_SOURCES, type JobSource, type JobStage } from '@roofline/shared';
import { Button, Field, Select, useToast, type SelectOption } from '@roofline/ui';
import { ApiError, apiFetch } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { create } from '../../copy/create.ts';
import { errors } from '../../copy/errors.ts';
import { AddressFields, EMPTY_ADDRESS, type AddressValue } from './AddressFields.tsx';
import { CustomerPicker } from './CustomerPicker.tsx';
import { useCreateCustomer, useCreateJob, useCreateProperty, useCustomerHomes, type CustomerInput, type CustomerRecord } from './api.ts';
import styles from './NewJob.module.css';

/** The home choice that means "a new address". */
const NEW_HOME = '__new__';

/** The fields this form shows a message under: the name of a new customer, the value, and the address. */
type FormField = 'name' | 'value' | keyof AddressValue;
type FieldErrors = Partial<Record<FormField, string>>;

const ADDRESS_FIELDS: readonly string[] = ['addressLine', 'city', 'state', 'zip'];

function isAddressField(field: string): field is keyof AddressValue {
  return ADDRESS_FIELDS.includes(field);
}

/** The job value the person typed, in whole cents: undefined when blank, null when it is not a dollar amount. */
function valueToCents(text: string): number | undefined | null {
  const trimmed = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (trimmed === '') return undefined;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return Math.round(parseFloat(trimmed) * 100);
}

/** The customer named in the URL (`?customerId=`), loaded so the form can show and use it. GET /api/customers/:id answers the flat customer. */
function usePresetCustomer(id: string | null) {
  return useQuery({
    queryKey: ['create', 'customer', id],
    enabled: id !== null,
    queryFn: ({ signal }) => apiFetch<CustomerRecord>(`/api/customers/${encodeURIComponent(id ?? '')}`, { signal }),
  });
}

// A job is created in one of the first three stages: Won needs a value, Lost needs a reason, and Installed only follows Won
const CREATE_STAGES = ['lead', 'inspection', 'proposal'] as const satisfies readonly JobStage[];
const stageOptions: SelectOption[] = CREATE_STAGES.map((stage) => ({ value: stage, label: create.stageNames[stage] }));
// Front Desk jobs are made by the assistant, never picked by a person (C1 Ruling CG); the board filter keeps the source.
const sourceOptions: SelectOption[] = JOB_SOURCES.filter((source) => source !== 'front_desk' && source !== 'app').map((source) => ({
  value: source,
  label: create.sourceNames[source],
}));

/** The New job screen: a customer, then a home, then the job's details. One form, no modal. */
export function NewJob() {
  const [params] = useSearchParams();
  const presetId = params.get('customerId');
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const preset = usePresetCustomer(presetId);
  const createCustomer = useCreateCustomer();
  const createProperty = useCreateProperty();
  const createJob = useCreateJob();

  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  // The customer chosen on this screen, or null after it was cleared. Until a choice is made, the one in the URL stands.
  const [picked, setPicked] = useState<{ customer: CustomerRecord | null } | null>(null);
  const customer = picked ? picked.customer : (preset.data ?? null);

  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');

  // null means the default: the first home if there is one, else a new address
  const [homeChoice, setHomeChoice] = useState<string | null>(null);
  const [address, setAddress] = useState<AddressValue>(EMPTY_ADDRESS);
  const [stage, setStage] = useState<JobStage>('lead');
  const [source, setSource] = useState<JobSource>('manual');
  const [value, setValue] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  // Ids made by earlier tries of this form, so a retry after a later failure never creates them twice
  const [madeCustomerId, setMadeCustomerId] = useState<string | null>(null);
  const [madePropertyId, setMadePropertyId] = useState<string | null>(null);

  /** A different customer, or none: the home picked and any home made for the old one no longer apply. */
  function chooseCustomer(next: CustomerRecord | null) {
    setPicked({ customer: next });
    setHomeChoice(null);
    setMadePropertyId(null);
  }

  const existingCustomerId = mode === 'existing' ? (customer?.id ?? null) : null;
  const homes = useCustomerHomes(existingCustomerId);
  const homeList = homes.data?.properties ?? [];
  const homeId = homeChoice ?? homeList[0]?.id ?? NEW_HOME;
  const usesNewHome = mode === 'new' || (homes.isSuccess && (homeList.length === 0 || homeId === NEW_HOME));

  const showDetails = mode === 'new' || customer !== null;
  const ready = me.data !== undefined && (mode === 'new' || (customer !== null && homes.isSuccess));

  const homeOptions: SelectOption[] = [
    ...homeList.map((home) => ({ value: home.id, label: `${home.addressLine}, ${home.city}` })),
    { value: NEW_HOME, label: create.newJob.newAddress },
  ];

  const addressErrors: Partial<Record<keyof AddressValue, string>> = {
    addressLine: fieldErrors.addressLine,
    city: fieldErrors.city,
    state: fieldErrors.state,
    zip: fieldErrors.zip,
  };

  /** A message from the server lands under its field when this form has one, and in a toast otherwise. */
  function showFailure(error: unknown) {
    if (!(error instanceof ApiError)) {
      toast.show(errors.generic, 'error');
      return;
    }
    const field = error.field;
    if (field === 'displayName') {
      setFieldErrors((current) => ({ ...current, name: error.message }));
    } else if (field === 'valueCents') {
      setFieldErrors((current) => ({ ...current, value: error.message }));
    } else if (field !== undefined && isAddressField(field)) {
      setFieldErrors((current) => ({ ...current, [field]: error.message }));
    } else {
      toast.show(error.message, 'error');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy || me.data === undefined) return;

    const cents = valueToCents(value);
    if (cents === null) {
      setFieldErrors({ value: errors.generic });
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      let customerId: string | null = mode === 'existing' ? (customer?.id ?? null) : madeCustomerId;
      if (customerId === null) {
        const input: CustomerInput = { displayName: newName.trim() };
        const phone = newPhone.trim();
        const email = newEmail.trim();
        if (phone !== '') input.phones = [{ number: phone, primary: true }];
        if (email !== '') input.emails = [email];
        const created = await createCustomer.mutateAsync(input);
        customerId = created.id;
        setMadeCustomerId(created.id);
      }

      let propertyId: string | null = usesNewHome ? madePropertyId : homeId;
      if (propertyId === null) {
        const property = await createProperty.mutateAsync({ customerId, ...address });
        propertyId = property.id;
        setMadePropertyId(property.id);
        if (property.lat === null || property.lng === null) toast.show(create.notOnMap, 'info');
      }

      const job = await createJob.mutateAsync({
        customerId,
        propertyId,
        stage,
        source,
        assignedUserId: me.data.user.id,
        ...(cents === undefined ? {} : { valueCents: cents }),
      });
      void navigate(`/jobs/${job.id}`);
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <section className={styles.step}>
          <h3 className={styles.heading}>{create.newJob.stepCustomer}</h3>
          {mode === 'existing' && customer !== null ? (
            <div className={styles.chosen}>
              <span>{customer.displayName}</span>
              <Button variant="ghost" onClick={() => chooseCustomer(null)}>
                {create.newJob.changeCustomer}
              </Button>
            </div>
          ) : null}
          {mode === 'existing' && customer === null ? (
            <>
              <CustomerPicker selected={null} onSelect={(next) => chooseCustomer(next)} />
              <Button
                variant="ghost"
                onClick={() => {
                  chooseCustomer(null);
                  setMode('new');
                }}
              >
                {create.newJob.newCustomer}
              </Button>
            </>
          ) : null}
          {mode === 'new' ? (
            <>
              <Field
                label={create.newJob.newCustomerName}
                name="name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                error={fieldErrors.name}
              />
              <Field
                label={create.newJob.newCustomerPhone}
                name="phone"
                type="tel"
                value={newPhone}
                onChange={(event) => setNewPhone(event.target.value)}
              />
              <Field
                label={create.newJob.newCustomerEmail}
                name="email"
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
              />
              <Button
                variant="ghost"
                onClick={() => {
                  setMode('existing');
                  setHomeChoice(null);
                  setMadePropertyId(null);
                }}
              >
                {create.newJob.useExisting}
              </Button>
            </>
          ) : null}
        </section>

        {showDetails ? (
          <section className={styles.step}>
            <h3 className={styles.heading}>{create.newJob.stepHome}</h3>
            {mode === 'existing' && homes.isError ? <p className={styles.note}>{errors.generic}</p> : null}
            {mode === 'existing' && homes.isSuccess && homeList.length > 0 ? (
              <Select label={create.newJob.pickHome} value={homeId} options={homeOptions} onChange={(next) => setHomeChoice(next)} />
            ) : null}
            {mode === 'existing' && homes.isSuccess && homeList.length === 0 ? <p className={styles.note}>{create.newJob.noHomes}</p> : null}
            {usesNewHome ? <AddressFields value={address} onChange={(next) => setAddress(next)} errors={addressErrors} /> : null}
          </section>
        ) : null}

        {showDetails ? (
          <section className={styles.step}>
            <h3 className={styles.heading}>{create.newJob.stepDetails}</h3>
            <div className={styles.row}>
              <Select label={create.newJob.stage} value={stage} options={stageOptions} onChange={(next) => setStage(next as JobStage)} />
              <Select label={create.newJob.source} value={source} options={sourceOptions} onChange={(next) => setSource(next as JobSource)} />
            </div>
            <div className={styles.row}>
              <Field label={create.newJob.rep} name="rep" value={create.newJob.repYou} readOnly />
              <Field
                label={create.newJob.value}
                name="value"
                inputMode="decimal"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                error={fieldErrors.value}
              />
            </div>
            <Button type="submit" variant="primary" busy={busy} disabled={!ready} className={styles.submit}>
              {create.newJob.submit}
            </Button>
          </section>
        ) : null}
      </form>
    </div>
  );
}
