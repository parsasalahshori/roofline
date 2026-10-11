import { Button, Field } from '@roofline/ui';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { apiFetch } from '../../api/client.ts';
import { auth } from '../../copy/auth.ts';
import styles from './Auth.module.css';
import { AuthLayout, FormAlert } from './AuthLayout.tsx';
import { formErrors } from './formErrors.ts';

/** Two pages on one address: ask for a link, and (with the token the link carries) choose the new password. */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token');
  return token ? <ChooseNewPassword token={token} /> : <AskForLink />;
}

function AskForLink() {
  const [email, setEmail] = useState('');
  const request = useMutation({
    mutationFn: (address: string) =>
      apiFetch<{ ok: true }>('/api/auth/reset-request', { method: 'POST', body: { email: address }, redirectOn401: false }),
  });
  const problems = formErrors(request.error, ['email']);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    request.mutate(email);
  }

  // The same words whether or not the address has an account, so this page cannot be used to find out
  if (request.isSuccess) {
    return (
      <AuthLayout title={auth.resetTitle}>
        <p role="status" className={styles.note}>
          {auth.resetSent}
        </p>
        <Button variant="ghost" href="/sign-in">
          {auth.backToSignIn}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={auth.resetTitle}>
      <p className={styles.intro}>{auth.resetIntro}</p>
      <form className={styles.form} onSubmit={submit} noValidate>
        <Field
          label={auth.email}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          error={problems.forField('email')}
        />
        <FormAlert message={problems.general} />
        <Button type="submit" variant="primary" busy={request.isPending}>
          {auth.sendLink}
        </Button>
      </form>
      <Button variant="ghost" href="/sign-in">
        {auth.backToSignIn}
      </Button>
    </AuthLayout>
  );
}

function ChooseNewPassword({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: (newPassword: string) =>
      apiFetch<{ ok: true }>('/api/auth/reset', { method: 'POST', body: { token, password: newPassword }, redirectOn401: false }),
  });
  const problems = formErrors(reset.error, ['password']);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    reset.mutate(password);
  }

  if (reset.isSuccess) {
    return (
      <AuthLayout title={auth.newPasswordTitle}>
        <p role="status" className={styles.note}>
          {auth.passwordChanged}
        </p>
        <Button variant="primary" href="/sign-in">
          {auth.signIn}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={auth.newPasswordTitle}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <Field
          label={auth.newPassword}
          help={auth.passwordHelp}
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          error={problems.forField('password')}
        />
        <FormAlert message={problems.general} />
        <Button type="submit" variant="primary" busy={reset.isPending}>
          {auth.savePassword}
        </Button>
      </form>
      {/* The link in the email is good once, for an hour: a dead one needs a new one */}
      {problems.api?.status === 400 && problems.general !== undefined ? (
        <Button variant="ghost" href="/reset">
          {auth.askNewLink}
        </Button>
      ) : null}
    </AuthLayout>
  );
}
