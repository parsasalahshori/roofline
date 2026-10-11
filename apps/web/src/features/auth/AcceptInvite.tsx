import { Button, Field } from '@roofline/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { Account } from '../../api/types.ts';
import { auth } from '../../copy/auth.ts';
import styles from './Auth.module.css';
import { AuthLayout, FormAlert } from './AuthLayout.tsx';
import { formErrors } from './formErrors.ts';

/** Where the sign-in page should send a person back to once they have signed in: this invite. */
function signInThenInvite(token: string): string {
  const invite = '/invite?' + new URLSearchParams({ token }).toString();
  return '/sign-in?' + new URLSearchParams({ next: invite }).toString();
}

/** The page an invite link opens: a new person gives a name and a password; someone with an account signs in first. */
export function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token');
  if (!token) {
    return (
      <AuthLayout title={auth.inviteTitle}>
        <FormAlert message={auth.linkIncomplete} />
      </AuthLayout>
    );
  }
  return <InviteForm token={token} />;
}

function InviteForm({ token }: { token: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const accept = useMutation({
    mutationFn: (person: { name: string; password: string }) =>
      apiFetch<Account>('/api/auth/accept-invite', { method: 'POST', body: { token, ...person }, redirectOn401: false }),
    onSuccess: (account) => {
      // The answer is who is signed in now, so the app does not need to ask again. Anything held for another person goes.
      queryClient.clear();
      queryClient.setQueryData(keys.me, account);
      void navigate('/', { replace: true });
    },
  });
  const problems = formErrors(accept.error, ['name', 'password']);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    accept.mutate({ name, password });
  }

  return (
    <AuthLayout title={auth.inviteTitle}>
      <p className={styles.intro}>{auth.inviteIntro}</p>
      <form className={styles.form} onSubmit={submit} noValidate>
        <Field
          label={auth.name}
          name="name"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          error={problems.forField('name')}
        />
        <Field
          label={auth.password}
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
        <Button type="submit" variant="primary" busy={accept.isPending}>
          {auth.acceptInvite}
        </Button>
      </form>
      <div className={styles.links}>
        {/* Someone who already has an account proves it by signing in, then comes back here */}
        {problems.api?.status === 401 ? (
          <Button variant="primary" href={signInThenInvite(token)}>
            {auth.signInToJoin}
          </Button>
        ) : null}
        {problems.api?.status === 409 ? (
          <Button variant="primary" href="/">
            {auth.continue}
          </Button>
        ) : null}
      </div>
    </AuthLayout>
  );
}
