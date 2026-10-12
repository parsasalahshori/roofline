import { Button, Field, useToast } from '@roofline/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { useSignIn } from '../../api/hooks.ts';
import { resetSignInRedirect } from '../../app/RequireSession.tsx';
import { auth } from '../../copy/auth.ts';
import { errors } from '../../copy/errors.ts';
import { GoogleButton } from '../signup/GoogleButton.tsx';
import { useAuthConfig, useGoogleSignIn } from '../signup/api.ts';
import styles from './Auth.module.css';
import { AuthLayout, FormAlert } from './AuthLayout.tsx';
import { formErrors } from './formErrors.ts';
import { safeNext } from './safeNext.ts';

export function SignIn() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const signIn = useSignIn();
  const toast = useToast();
  const googleClientId = useAuthConfig().data?.googleClientId ?? null;
  const googleSignIn = useGoogleSignIn();
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

  function onCredential(credential: string) {
    googleSignIn.mutate(
      { credential },
      {
        onSuccess: () => {
          void navigate(next, { replace: true });
        },
        onError: (error) => {
          // A new Google account has no company yet: the sign-up page asks for it
          if (error instanceof ApiError && error.field === 'companyName') {
            void navigate('/sign-up');
            return;
          }
          toast.show(formErrors(error, []).general ?? errors.generic, 'error');
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
      <Button variant="ghost" href="/sign-up">
        {auth.createAccount}
      </Button>
      <GoogleButton clientId={googleClientId} onCredential={onCredential} />
    </AuthLayout>
  );
}
