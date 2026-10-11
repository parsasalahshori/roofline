import { Button, Field } from '@roofline/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useSignIn } from '../../api/hooks.ts';
import { resetSignInRedirect } from '../../app/RequireSession.tsx';
import { auth } from '../../copy/auth.ts';
import styles from './Auth.module.css';
import { AuthLayout, FormAlert } from './AuthLayout.tsx';
import { formErrors } from './formErrors.ts';
import { safeNext } from './safeNext.ts';

export function SignIn() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const signIn = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const problems = formErrors(signIn.error, ['email', 'password']);

  // A person has arrived at sign-in, so the next lost session should send them here again
  useEffect(() => {
    resetSignInRedirect();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    signIn.mutate(
      { email, password },
      {
        onSuccess: () => {
          void navigate(next, { replace: true });
        },
      },
    );
  }

  return (
    <AuthLayout title={auth.signInTitle}>
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
        <Field
          label={auth.password}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          error={problems.forField('password')}
        />
        <FormAlert message={problems.general} />
        <Button type="submit" variant="primary" busy={signIn.isPending}>
          {auth.signIn}
        </Button>
      </form>
      <Button variant="ghost" href="/reset">
        {auth.forgot}
      </Button>
    </AuthLayout>
  );
}
