import type { ConsentStatus, CustomerView } from '@roofline/shared';
import { Button, Checkbox, Field, Icon, IconButton, Listbox, Sheet, Toggle, UiLink, useToast, type ListboxOption } from '@roofline/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client.ts';
import { common } from '../../copy/common.ts';
import { customers } from '../../copy/customers.ts';
import { useUpdateCustomer, type CustomerPatch } from './api.ts';
import styles from './EditCustomerSheet.module.css';

export type EditCustomerSheetProps = { view: CustomerView; onDone: () => void };

type PhoneRow = { key: number; number: string; label: string };
type EmailRow = { key: number; value: string };
/** What a save error shows under one phone: the server's message, and the typed number when another customer has it. */
type PhoneError = { message: string; openQuery?: string };

const PHONE_FIELD = /^phones\.(\d+)\.number$/;
/** Consent the rep picks from. 'attested' is only offered when the customer already has it. */
const CHOSEN_CONSENT = ['none', 'express', 'written', 'revoked'] as const;

// Keys only tell rows apart while the sheet is open, so one counter for the whole module is enough.
let lastKey = 0;
function freshKey(): number {
  lastKey += 1;
  return lastKey;
}

function startPhones(phones: CustomerView['customer']['phones']) {
  const rows = phones.map((phone) => ({ key: freshKey(), number: phone.e164, label: phone.label ?? '' }));
  const primary = Math.max(0, phones.findIndex((phone) => phone.primary));
  return { rows, primaryKey: rows[primary]?.key };
}

/** Tags typed as "roof, vip": split on commas, trimmed, empty ones dropped, repeats dropped. */
function parseTags(text: string): string[] {
  const tags = text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
  return [...new Set(tags)];
}

function consentOptions(current: ConsentStatus): ListboxOption<ConsentStatus>[] {
  const choices = CHOSEN_CONSENT.map((status) => ({ value: status, label: customers.edit.consentOptions[status] }));
  return current === 'attested' ? [{ value: 'attested', label: customers.consent.attested }, ...choices] : choices;
}

/** The close mark in the remove buttons. Decorative: the button carries the label. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** The panel that edits one customer's names, phones, emails, tags and texting consent. A rep sees everything but consent. */
export function EditCustomerSheet({ view, onDone }: EditCustomerSheetProps) {
  const { customer, can } = view;
  const toast = useToast();
  const update = useUpdateCustomer(customer.id);
  const formId = useId();

  const [displayName, setDisplayName] = useState(customer.displayName);
  const [firstName, setFirstName] = useState(customer.firstName ?? '');
  const [lastName, setLastName] = useState(customer.lastName ?? '');
  const [start] = useState(() => startPhones(customer.phones));
  const [phones, setPhones] = useState<PhoneRow[]>(start.rows);
  const [primaryKey, setPrimaryKey] = useState<number | undefined>(start.primaryKey);
  const [emails, setEmails] = useState<EmailRow[]>(() => customer.emails.map((value) => ({ key: freshKey(), value })));
  const [tags, setTags] = useState(customer.tags.join(', '));
  const [consent, setConsent] = useState<ConsentStatus>(customer.consent);
  const [consentNote, setConsentNote] = useState('');
  const [doNotContact, setDoNotContact] = useState(customer.doNotContact);

  const [nameError, setNameError] = useState<string>();
  const [phoneErrors, setPhoneErrors] = useState<Record<number, PhoneError>>({});

  // Blank rows are not saved, so the primary is the chosen row when it is still kept, else the first kept row
  const kept = phones.filter((phone) => phone.number.trim() !== '');
  const effectivePrimary = kept.some((phone) => phone.key === primaryKey) ? primaryKey : kept[0]?.key;

  function updatePhone(key: number, change: Partial<Omit<PhoneRow, 'key'>>) {
    setPhones((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function showSaveError(error: unknown, rows: PhoneRow[]) {
    if (!(error instanceof ApiError)) {
      toast.show(customers.edit.saveFailed, 'error');
      return;
    }
    const match = error.field === undefined ? null : PHONE_FIELD.exec(error.field);
    const row = match ? rows[Number(match[1])] : undefined;
    if (row !== undefined) {
      // A 409 is another customer's number; the link searches the customers list for what was typed
      const openQuery = error.status === 409 ? row.number.trim() : undefined;
      setPhoneErrors({ [row.key]: { message: error.message, openQuery } });
      return;
    }
    if (error.field === 'displayName') {
      setNameError(error.message);
      return;
    }
    toast.show(error.message || customers.edit.saveFailed, 'error');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNameError(undefined);
    setPhoneErrors({});

    const rows = phones.filter((phone) => phone.number.trim() !== '');
    const primaryIndex = Math.max(0, rows.findIndex((phone) => phone.key === effectivePrimary));
    const patch: CustomerPatch = {
      displayName: displayName.trim(),
      firstName: firstName.trim() === '' ? null : firstName.trim(),
      lastName: lastName.trim() === '' ? null : lastName.trim(),
      phones: rows.map((phone, index) => {
        const label = phone.label.trim();
        return { number: phone.number.trim(), ...(label === '' ? {} : { label }), primary: index === primaryIndex };
      }),
      emails: emails.map((email) => email.value.trim()).filter((email) => email !== ''),
      tags: parseTags(tags),
    };

    // A rep's patch never carries consent: the server answers 403 to it
    if (can.changeConsent) {
      patch.doNotContact = doNotContact;
      if (consent !== customer.consent && consent !== 'attested') patch.smsConsentStatus = consent;
      const note = consentNote.trim();
      if (consent === 'written' && note !== '') {
        // The server takes a note only with the written status it records, so the status goes with it
        patch.smsConsentStatus = 'written';
        patch.consentNote = note;
      }
    }

    try {
      await update.mutateAsync(patch);
      toast.show(customers.edit.savedToast, 'success');
      onDone();
    } catch (error) {
      showSaveError(error, rows);
    }
  }

  return (
    <Sheet
      open
      title={customers.edit.title}
      closeLabel={common.close}
      onClose={onDone}
      footer={
        <Button type="submit" form={formId} variant="primary" busy={update.isPending} disabled={displayName.trim() === ''}>
          {update.isPending ? customers.edit.saving : customers.edit.save}
        </Button>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void save(event)}>
        <Field
          label={customers.edit.displayName}
          required
          value={displayName}
          error={nameError}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <div className={styles.names}>
          <Field label={customers.edit.firstName} value={firstName} onChange={(event) => setFirstName(event.target.value)} />
          <Field label={customers.edit.lastName} value={lastName} onChange={(event) => setLastName(event.target.value)} />
        </div>

        <section className={styles.section}>
          <h3 className={styles.heading}>{customers.edit.phonesHeading}</h3>
          {phones.map((phone) => {
            const error = phoneErrors[phone.key];
            return (
              <div key={phone.key} className={styles.row}>
                <div className={styles.rowFields}>
                  <Field
                    label={customers.edit.phoneNumber}
                    type="tel"
                    autoComplete="tel"
                    value={phone.number}
                    error={error?.message}
                    onChange={(event) => updatePhone(phone.key, { number: event.target.value })}
                  />
                  <Field label={customers.edit.phoneLabel} value={phone.label} onChange={(event) => updatePhone(phone.key, { label: event.target.value })} />
                </div>
                <div className={styles.rowActions}>
                  <div className={styles.primary}>
                    <Checkbox
                      checked={phone.key === effectivePrimary}
                      label={customers.edit.phonePrimary}
                      onChange={(next) => {
                        // Exactly one primary: unticking the chosen one does nothing, choosing another moves it
                        if (next) setPrimaryKey(phone.key);
                      }}
                    />
                  </div>
                  <IconButton
                    label={customers.edit.removePhone}
                    icon={<CloseIcon />}
                    className={styles.remove}
                    onClick={() => setPhones((rows) => rows.filter((row) => row.key !== phone.key))}
                  />
                </div>
                {error?.openQuery === undefined ? null : (
                  <UiLink className={styles.conflict} href={`/customers?q=${encodeURIComponent(error.openQuery)}`}>
                    {customers.edit.openThatCustomer}
                  </UiLink>
                )}
              </div>
            );
          })}
          <Button
            variant="ghost"
            className={styles.addRow}
            onClick={() => setPhones((rows) => [...rows, { key: freshKey(), number: '', label: '' }])}
          >
            <Icon name="plus" size={16} />
            {customers.edit.addPhone}
          </Button>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{customers.edit.emailsHeading}</h3>
          {emails.map((email) => (
            <div key={email.key} className={styles.row}>
              <div className={styles.rowActions}>
                <Field
                  label={customers.edit.email}
                  type="email"
                  autoComplete="email"
                  className={styles.emailField}
                  value={email.value}
                  onChange={(event) => setEmails((rows) => rows.map((row) => (row.key === email.key ? { ...row, value: event.target.value } : row)))}
                />
                <IconButton
                  label={customers.edit.removeEmail}
                  icon={<CloseIcon />}
                  className={styles.remove}
                  onClick={() => setEmails((rows) => rows.filter((row) => row.key !== email.key))}
                />
              </div>
            </div>
          ))}
          <Button variant="ghost" className={styles.addRow} onClick={() => setEmails((rows) => [...rows, { key: freshKey(), value: '' }])}>
            <Icon name="plus" size={16} />
            {customers.edit.addEmail}
          </Button>
        </section>

        <Field label={customers.edit.tags} help={customers.edit.tagsHelp} value={tags} onChange={(event) => setTags(event.target.value)} />

        {can.changeConsent ? (
          <section className={styles.section}>
            <Listbox
              label={customers.edit.consent}
              value={consent}
              options={consentOptions(customer.consent)}
              help={consent === 'written' && customer.consent !== 'written' ? customers.edit.consentConfirm : undefined}
              onChange={setConsent}
            />
            {consent === 'written' ? (
              <Field
                label={customers.edit.consentNote}
                help={customers.edit.consentNoteHelp}
                value={consentNote}
                onChange={(event) => setConsentNote(event.target.value)}
              />
            ) : null}
            <Toggle checked={doNotContact} label={customers.doNotContact} onChange={setDoNotContact} />
          </section>
        ) : null}

      </form>
    </Sheet>
  );
}
