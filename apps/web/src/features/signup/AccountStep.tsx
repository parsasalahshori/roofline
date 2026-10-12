import { Button, Field } from '@roofline/ui';
import type { FormEvent } from 'react';
import { auth } from '../../copy/auth.ts';
import styles from '../auth/Auth.module.css';
import { FormAlert } from '../auth/AuthLayout.tsx';
import type { FormErrors } from '../auth/formErrors.ts';
import { GoogleButton } from './GoogleButton.tsx';

export type AccountFieldName = 'name' | 'email' | 'password';

export type AccountStepProps = {
  name: string;
  email: string;
  password: string;
  onChange: (field: AccountFieldName, value: string) => void;
  errors: FormErrors;
  onContinue: () => void;
  googleClientId: string | null;
  onCredential: (credential: string) => void;
};

/** Step 1 of sign-up: who the person is. Google sign-in sits below the form, when it is set up. */
export function AccountStep({
  name,
  email,
  password,
  onChange,
  errors,
  onContinue,
  googleClientId,
  onCredential,
}: AccountStepProps) {
  const passwordError = errors.forField('password');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onContinue();
  }

  return (
    <>
      <form className={styles.form} onSubmit={submit} noValidate>
        <Field
          label={auth.yourName}
          name="name"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            onChange('name', event.target.value);
          }}
          error={errors.forField('name')}
        />
        <Field
          label={auth.email}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            onChange('email', event.target.value);
          }}
          error={errors.forField('email')}
        />
        <Field
          label={auth.password}
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            onChange('password', event.target.value);
          }}
          // The error and the help say the same thing, so the error replaces the help
          help={passwordError ? undefined : auth.passwordHelp}
          error={passwordError}
        />
        <FormAlert message={errors.general} />
        <Button type="submit" variant="primary">
          {auth.continue}
        </Button>
      </form>
      <GoogleButton clientId={googleClientId} onCredential={onCredential} />
    </>
  );
}
