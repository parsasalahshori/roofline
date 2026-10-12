import { Button, Field } from '@roofline/ui';
import type { FormEvent } from 'react';
import { auth } from '../../copy/auth.ts';
import styles from '../auth/Auth.module.css';
import { FormAlert } from '../auth/AuthLayout.tsx';
import type { FormErrors } from '../auth/formErrors.ts';

export type CompanyFieldName = 'companyName' | 'companyPhone' | 'companyAddress';

export type CompanyStepProps = {
  companyName: string;
  companyPhone: string;
  companyAddress: string;
  onChange: (field: CompanyFieldName, value: string) => void;
  errors: FormErrors;
  busy: boolean;
  onSubmit: () => void;
};

/** Step 2 of sign-up: the company, which starts the trial. */
export function CompanyStep({ companyName, companyPhone, companyAddress, onChange, errors, busy, onSubmit }: CompanyStepProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Field
        label={auth.companyName}
        name="companyName"
        autoComplete="organization"
        value={companyName}
        onChange={(event) => {
          onChange('companyName', event.target.value);
        }}
        error={errors.forField('companyName')}
      />
      <Field
        label={auth.businessPhone}
        name="companyPhone"
        type="tel"
        autoComplete="tel"
        value={companyPhone}
        onChange={(event) => {
          onChange('companyPhone', event.target.value);
        }}
        error={errors.forField('companyPhone')}
      />
      <Field
        label={auth.businessAddress}
        name="companyAddress"
        autoComplete="street-address"
        help={auth.addressHelp}
        value={companyAddress}
        onChange={(event) => {
          onChange('companyAddress', event.target.value);
        }}
        error={errors.forField('companyAddress')}
      />
      <FormAlert message={errors.general} />
      <Button type="submit" variant="primary" busy={busy}>
        {auth.startTrial}
      </Button>
    </form>
  );
}
