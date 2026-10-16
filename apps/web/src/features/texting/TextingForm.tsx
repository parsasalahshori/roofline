import { useState, type FormEvent } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  Field,
  Listbox,
  Panel,
  UiLink,
  useToast,
  type FieldProps,
  type ListboxOption,
} from '@roofline/ui';
import {
  BRAND_FIELDS,
  BUSINESS_TYPES,
  USE_CASE_LABEL,
  type BrandField,
  type BrandInfo,
  type BusinessType,
  type TextingView,
} from '@roofline/shared';
import { texting } from '../../copy/texting.ts';
import { formErrors } from '../auth/formErrors.ts';
import form from '../settings/form.module.css';
import { useSubmitRegistration } from './api.ts';
import styles from './TextingForm.module.css';

/** Every field as the form holds it: the business type is the list's value, so it is text here. */
type Values = Record<BrandField, string>;

type TextField = Exclude<BrandField, 'businessType'>;

/** How each text input behaves: its type, its keyboard, and what the browser may fill in. */
const INPUT_PROPS: Record<TextField, Pick<FieldProps, 'type' | 'autoComplete' | 'inputMode'>> = {
  legalName: { autoComplete: 'organization' },
  ein: { inputMode: 'numeric', autoComplete: 'off' },
  street: { autoComplete: 'street-address' },
  city: { autoComplete: 'address-level2' },
  state: { autoComplete: 'address-level1' },
  zip: { inputMode: 'numeric', autoComplete: 'postal-code' },
  website: { type: 'url', inputMode: 'url', autoComplete: 'url' },
  contactFirstName: { autoComplete: 'given-name' },
  contactLastName: { autoComplete: 'family-name' },
  contactEmail: { type: 'email', autoComplete: 'email' },
  contactPhone: { type: 'tel', autoComplete: 'tel' },
  contactTitle: { autoComplete: 'organization-title' },
};

/** The copy key for each business type value the server accepts. */
const BUSINESS_TYPE_LABEL: Record<BusinessType, keyof typeof texting.businessTypes> = {
  llc: 'llc',
  corporation: 'corporation',
  partnership: 'partnership',
  non_profit: 'nonProfit',
};

// The empty first option stands for "not picked yet", so an empty business type never shows as LLC
const BUSINESS_OPTIONS: ListboxOption[] = [
  { value: '', label: '—' },
  ...BUSINESS_TYPES.map((type) => ({ value: type, label: texting.businessTypes[BUSINESS_TYPE_LABEL[type]] })),
];

const FORM_FIELD_NAMES = BRAND_FIELDS.map((field) => `brand.${field}`);

/** The two panels of fields, in the order they are asked. Together they are every field of a registration (a test holds that). */
export const BUSINESS_FIELDS: readonly BrandField[] = ['legalName', 'ein', 'businessType', 'street', 'city', 'state', 'zip', 'website'];
export const CONTACT_FIELDS: readonly BrandField[] = ['contactFirstName', 'contactLastName', 'contactEmail', 'contactPhone', 'contactTitle'];

/** The fields that take a whole row of the two-column grid: a name and a street run long. */
const WIDE: ReadonlySet<BrandField> = new Set<BrandField>(['legalName', 'street']);

/** What the form shows. A missing value is an empty field. */
function toValues(source: Partial<BrandInfo>): Values {
  return Object.fromEntries(BRAND_FIELDS.map((field) => [field, source[field] ?? ''])) as Values;
}

/** The registration form: prefilled from the company, with the rejected fields highlighted when a fix is due. */
export function TextingForm({ view }: { view: TextingView }) {
  const source = view.brand ?? view.defaults;
  const [values, setValues] = useState<Values>(() => toValues(source));
  // On by default when the company has no website of its own to point at
  const [useHostedPages, setUseHostedPages] = useState(() => toValues(source).website === '');
  // Fields edited since this form was shown: their rejection highlight goes
  const [edited, setEdited] = useState<ReadonlySet<BrandField>>(() => new Set());
  // Fields edited since the last submit: a server message about one of them is out of date
  const [editedSinceSubmit, setEditedSinceSubmit] = useState<ReadonlySet<BrandField>>(() => new Set());

  const registration = useSubmitRegistration();
  const toast = useToast();
  const problems = formErrors(registration.error, FORM_FIELD_NAMES);
  const needsFix = view.state === 'needs_fix';
  const blocked = view.needsPaymentMethod || view.needsVerifiedEmail;

  function changeField(field: BrandField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setEdited((current) => new Set(current).add(field));
    setEditedSinceSubmit((current) => new Set(current).add(field));
  }

  // A message from the server wins over the plain "check this" highlight; both go once the field is edited
  function fieldError(field: BrandField): string | undefined {
    const serverMessage = editedSinceSubmit.has(field) ? undefined : problems.forField(`brand.${field}`);
    if (serverMessage) return serverMessage;
    if (needsFix && view.rejectedFields.includes(field) && !edited.has(field)) return texting.checkThis;
    return undefined;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || registration.isPending) return;
    setEditedSinceSubmit(new Set());
    // The Select only offers the four types, or the empty choice the server rejects with a message
    const brand: BrandInfo = { ...values, businessType: values.businessType as BusinessType };
    registration.mutate(
      { brand, useHostedPolicyPages: useHostedPages },
      {
        onError: (error) => {
          const general = formErrors(error, FORM_FIELD_NAMES).general;
          if (general) toast.show(general, 'error');
        },
      },
    );
  }

  /** One field: the list for the business type, a text box for the rest. */
  const fieldFor = (field: BrandField) =>
    field === 'businessType' ? (
      <Listbox
        key={field}
        label={texting.fields[field]}
        value={values[field]}
        onChange={(value) => changeField(field, value)}
        options={BUSINESS_OPTIONS}
        error={fieldError(field)}
      />
    ) : (
      <Field
        key={field}
        name={field}
        className={WIDE.has(field) ? form.span : undefined}
        label={texting.fields[field]}
        value={values[field]}
        onChange={(event) => changeField(field, event.target.value)}
        error={fieldError(field)}
        {...INPUT_PROPS[field]}
      />
    );

  return (
    <div className={styles.root}>
      {needsFix && view.reason !== null ? <Banner tone="danger">{view.reason}</Banner> : null}
      {view.needsPaymentMethod ? (
        <Banner tone="warning" action={<UiLink href="/settings/billing" className={styles.bannerLink}>{texting.addCard}</UiLink>}>
          {texting.needsCard}
        </Banner>
      ) : null}
      {view.needsVerifiedEmail ? <Banner tone="warning">{texting.needsEmail}</Banner> : null}

      <form className={form.form} onSubmit={submit} noValidate>
        <Panel title={texting.panels.business}>
          <div className={form.grid}>{BUSINESS_FIELDS.map(fieldFor)}</div>
        </Panel>

        <Panel title={texting.panels.contact}>
          <div className={form.grid}>{CONTACT_FIELDS.map(fieldFor)}</div>
        </Panel>

        <Panel title={texting.panels.send}>
          <div className={styles.send}>
            <p className={form.help}>{texting.whatYouText(USE_CASE_LABEL)}</p>

            <div className={styles.choice}>
              <Checkbox checked={useHostedPages} onChange={setUseHostedPages} label={texting.useHostedPages} />
            </div>
            {useHostedPages ? (
              <div className={styles.links}>
                <a className={styles.link} href={view.hostedPolicyUrls.privacy} target="_blank" rel="noreferrer">
                  {texting.hostedPrivacy}
                </a>
                <a className={styles.link} href={view.hostedPolicyUrls.terms} target="_blank" rel="noreferrer">
                  {texting.hostedTerms}
                </a>
              </div>
            ) : null}

            <Button
              className={styles.submit}
              type="submit"
              variant="primary"
              busy={registration.isPending}
              disabled={blocked || registration.isPending}
            >
              {needsFix ? texting.fixAndResubmit : texting.send}
            </Button>
          </div>
        </Panel>
      </form>
    </div>
  );
}
