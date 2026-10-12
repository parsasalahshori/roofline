import { Button, useToast } from '@roofline/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import { auth } from '../../copy/auth.ts';
import { errors } from '../../copy/errors.ts';
import styles from '../auth/Auth.module.css';
import { AuthLayout } from '../auth/AuthLayout.tsx';
import { formErrors, type FormErrors } from '../auth/formErrors.ts';
import { AccountStep, type AccountFieldName } from './AccountStep.tsx';
import { CompanyStep, type CompanyFieldName } from './CompanyStep.tsx';
import { useAuthConfig, useGoogleSignIn, useSignUp } from './api.ts';

/** The fields on each step. A server message about one of them is shown on the step that holds it. */
const ACCOUNT_FIELDS: readonly string[] = ['name', 'email', 'password'];
const COMPANY_FIELDS: readonly string[] = ['companyName', 'companyPhone', 'companyAddress'];

/** The server's rule for a password, checked here first so a short one never leaves the page. */
const MIN_PASSWORD_LENGTH = 10;

type Values = Record<AccountFieldName | CompanyFieldName, string>;

const EMPTY: Values = { name: '', email: '', password: '', companyName: '', companyPhone: '', companyAddress: '' };

/** The public sign-up page: two short steps, then Setup. A Google credential can stand in for step 1. */
export function SignUp() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const googleClientId = useAuthConfig().data?.googleClientId ?? null;
  const signUp = useSignUp();
  const googleSignIn = useGoogleSignIn();

  const [step, setStep] = useState<1 | 2>(1);
  const [values, setValues] = useState<Values>(EMPTY);
  // The last failure from the server, shown under its field on the step that holds that field
  const [error, setError] = useState<Error | null>(null);
  const [passwordTooShort, setPasswordTooShort] = useState(false);
  // A Google credential waiting for the company details that step 2 collects
  const credential = useRef<string | null>(null);

  function change(field: AccountFieldName | CompanyFieldName, value: string) {
    setValues((previous) => ({ ...previous, [field]: value }));
    if (field === 'password') setPasswordTooShort(false);
  }

  function showStep(next: 1 | 2) {
    setError(null);
    setStep(next);
  }

  /** Puts a failed request where it belongs: on the step with its field, or as a toast when it has none. */
  function failed(failure: Error) {
    const apiError = failure instanceof ApiError ? failure : null;
    const field = apiError?.field;
    if (field !== undefined && ACCOUNT_FIELDS.includes(field)) {
      setStep(1);
      setError(failure);
    } else if (field !== undefined && COMPANY_FIELDS.includes(field)) {
      setStep(2);
      setError(failure);
    } else {
      toast.show(apiError?.message ?? errors.generic, 'error');
    }
  }

  function continueToCompany() {
    setError(null);
    if (values.password.length < MIN_PASSWORD_LENGTH) {
      setPasswordTooShort(true);
      return;
    }
    setPasswordTooShort(false);
    showStep(2);
  }

  function submitCompany() {
    setError(null);
    const company = {
      companyName: values.companyName,
      companyPhone: values.companyPhone,
      companyAddress: values.companyAddress,
    };
    const waiting = credential.current;
    if (waiting !== null) {
      googleSignIn.mutate(
        { credential: waiting, ...company },
        {
          onSuccess: () => {
            void navigate('/', { replace: true });
          },
          onError: failed,
        },
      );
      return;
    }
    signUp.mutate(
      { name: values.name, email: values.email, password: values.password, ...company },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: keys.me });
          void navigate('/settings/setup', { replace: true });
        },
        onError: failed,
      },
    );
  }

  function onCredential(value: string) {
    setError(null);
    googleSignIn.mutate(
      { credential: value },
      {
        onSuccess: () => {
          void navigate('/', { replace: true });
        },
        onError: (failure) => {
          // The account is new and needs its company first: keep the credential for step 2
          if (failure instanceof ApiError && failure.field === 'companyName') {
            credential.current = value;
            showStep(2);
            return;
          }
          failed(failure);
        },
      },
    );
  }

  const accountErrors: FormErrors = passwordTooShort
    ? { forField: (field) => (field === 'password' ? auth.passwordHelp : undefined), general: undefined, api: null }
    : formErrors(error, ACCOUNT_FIELDS);
  const companyErrors = formErrors(error, COMPANY_FIELDS);

  return (
    <AuthLayout title={auth.signUpTitle}>
      <p className={styles.note}>{auth.trialNote}</p>
      {step === 1 ? (
        <AccountStep
          name={values.name}
          email={values.email}
          password={values.password}
          onChange={change}
          errors={accountErrors}
          onContinue={continueToCompany}
          googleClientId={googleClientId}
          onCredential={onCredential}
        />
      ) : (
        <CompanyStep
          companyName={values.companyName}
          companyPhone={values.companyPhone}
          companyAddress={values.companyAddress}
          onChange={change}
          errors={companyErrors}
          busy={signUp.isPending || googleSignIn.isPending}
          onSubmit={submitCompany}
        />
      )}
      <Button variant="ghost" href="/sign-in">
        {auth.haveAccount}
      </Button>
    </AuthLayout>
  );
}
