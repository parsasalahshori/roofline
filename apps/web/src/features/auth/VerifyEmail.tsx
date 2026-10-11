import { Button } from '@roofline/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import { auth } from '../../copy/auth.ts';
import styles from './Auth.module.css';
import { AuthLayout, FormAlert } from './AuthLayout.tsx';
import { formErrors } from './formErrors.ts';

/** The page a "confirm your email" link opens: it confirms the address as soon as it shows. */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const queryClient = useQueryClient();
  const verify = useMutation({
    mutationFn: (value: string) =>
      apiFetch<{ ok: true }>('/api/auth/verify-email', { method: 'POST', body: { token: value }, redirectOn401: false }),
    // If this person is signed in, their address now counts as confirmed
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.me }),
  });

  // A link works once. React may run this effect twice while the page is being set up (in development),
  // and the second request would be told the link was used up, so only the first one is sent.
  const sent = useRef(false);
  const { mutate } = verify;
  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    mutate(token);
  }, [token, mutate]);

  // A link with no token cannot be confirmed; one with a token says why it failed, in the server's words
  const problem = token ? formErrors(verify.error, []).general : auth.linkIncomplete;

  return (
    <AuthLayout title={auth.verifyTitle}>
      {token && !verify.isSuccess && !verify.isError ? (
        <p role="status" className={styles.note}>
          {auth.verifying}
        </p>
      ) : null}
      {verify.isSuccess ? (
        <>
          <p role="status" className={styles.note}>
            {auth.emailConfirmed}
          </p>
          <Button variant="primary" href="/">
            {auth.continue}
          </Button>
        </>
      ) : null}
      <FormAlert message={problem} />
    </AuthLayout>
  );
}
